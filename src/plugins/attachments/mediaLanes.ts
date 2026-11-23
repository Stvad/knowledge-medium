/** Capture, upload and resolve attachments for one bound user. The browser and
 *  headless host supply their own stores, key policy and upload permissions. */

import type { Repo } from '@/data/repo.js'
import type { WorkspaceConversionRead } from '@/sync/keys/conversionState.js'
import type { SyncResolver } from '@/sync/keys/resolver.js'
import type { BlobStore } from './blobStore.js'
import type { ByteStore } from './byteStore.js'
import { captureMediaFiles, type MediaCaptureDeps, type MediaCaptureResult } from './mediaCapture.js'
import { createAssetResolver, type AssetResolver } from './resolver.js'
import { drainUploads } from './uploadDrain.js'
import { isAssetBlockPresent, reconcileUploads } from './uploadReconcile.js'
import { recoverFailedUploads } from './uploadRecovery.js'
import type { ByteUploadStatus, ByteUploadStore } from './uploadStore.js'

export interface MediaLaneDeps {
  readonly userId: string
  readonly byteStore: ByteStore
  readonly uploadStore: ByteUploadStore
  readonly blobStore: BlobStore
  /** The same session getter the blob store uses for PUT. */
  readonly getAccessToken: () => Promise<string | null>
  readonly keys: Pick<SyncResolver, 'getMaterializability' | 'getCek' | 'getContentKeyHmac'>
  /** The server's workspace row read now (`fetchWorkspaceConversionState`). */
  readonly readLiveWorkspace: (workspaceId: string) => Promise<WorkspaceConversionRead>
  /** Whether the bound user may upload now. A hold defers a record without spending
   *  its retry budget. A PUT after demotion could return 403 and permanently fail it. */
  readonly canDrain: () => boolean
  /** Non-reentrant pass lock. Capture and promote-only reconciliation are idempotent and run outside it. */
  readonly exclusive: (work: () => Promise<void>) => Promise<void>
  /** Publish queue status after the drain completes, before releasing the pass lock. */
  readonly afterPass?: () => Promise<void>
}

export interface MediaLanes {
  readonly resolver: AssetResolver
  capture(
    repo: Repo,
    workspaceId: string,
    files: readonly File[],
    options?: Pick<MediaCaptureDeps, 'txDescription'>,
  ): Promise<MediaCaptureResult[]>
  /** Upload every pending record. Never rejects. A call made while a pass runs
   *  settles after a further pass, which sees what that call was made for. */
  drain(): Promise<void>
  /** Settles once no drain is running. */
  settled(): Promise<void>
  /** Promote staged records whose block is present, leaving drain scheduling to the caller. */
  reconcile(repo: Pick<Repo, 'load'>): Promise<void>
  /** Probe failed records and drain the queue in the same exclusive pass. */
  recover(): Promise<void>
  counts(): Promise<Record<ByteUploadStatus, number>>
}

export const createMediaLanes = (deps: MediaLaneDeps): MediaLanes => {
  const {
    userId, byteStore, uploadStore: store, blobStore, keys, readLiveWorkspace,
    canDrain, getAccessToken, exclusive, afterPass,
  } = deps
  const keyDeps = {
    getMaterializability: keys.getMaterializability,
    getCek: keys.getCek,
    getContentKeyHmac: keys.getContentKeyHmac,
  }
  const uploadDeps = { store, blobStore, ...keyDeps, canUpload: canDrain }
  const runPass = async (label: 'drain' | 'recovery', beforeDrain?: () => Promise<unknown>): Promise<void> => {
    try {
      await exclusive(async () => {
        if (beforeDrain) await beforeDrain()
        await drainUploads(userId, { ...uploadDeps, byteStore, readLiveWorkspace })
        await afterPass?.()
      })
    } catch (error) {
      console.warn(`[mediaLanes] ${label} failed`, error)
    }
  }

  let running: Promise<void> | null = null
  let again = false
  const drain = (): Promise<void> => {
    if (!canDrain()) return running ?? Promise.resolve()
    again = true
    // The body awaits before its `finally`, so `running` is assigned before it is cleared.
    return (running ??= (async () => {
      try {
        do {
          again = false
          await runPass('drain')
        } while (again && canDrain())
      } finally {
        running = null
      }
    })())
  }

  return {
    resolver: createAssetResolver({ getUserId: () => userId, byteStore, blobStore, ...keyDeps }),
    capture: (repo, workspaceId, files, options = {}) => captureMediaFiles(workspaceId, files, {
      repo,
      byteStore,
      uploadStore: store,
      getUserId: () => userId,
      ...keyDeps,
      drain: () => void drain(),
      ...options,
    }),
    drain,
    settled: async () => { await running },
    async reconcile(repo) {
      await reconcileUploads(userId, { store, isBlockPresent: (_ws, id) => isAssetBlockPresent(repo, id) })
    },
    async recover() {
      if (!canDrain()) return
      await runPass('recovery', () => recoverFailedUploads(userId, { ...uploadDeps, getAccessToken }))
    },
    async counts() {
      const [staged, pending, failed] = await Promise.all(
        (['staged', 'pending', 'failed'] as const).map(status => store.countByStatus(userId, status)))
      return { staged, pending, failed }
    },
  }
}
