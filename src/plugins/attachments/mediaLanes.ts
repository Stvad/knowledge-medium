/**
 * The attachments lanes for a client that serves ONE user and owns its stores: the
 * headless host. It assembles the same pure pieces the browser wiring does
 * (`assetUpload.ts` / `assetResolver.ts`): capture, the up-lane drain, the boot
 * reconcile and the read resolver, with the stores, the blob store and the §6 key
 * deps injected. There is no ambient account and no local-only mode to track, so
 * nothing here reads `repoProvider`.
 *
 * No down-lane: bytes reach this client only by capture or by a read's fetch.
 */

import type { Repo } from '@/data/repo.js'
import type { WorkspaceConversionRead } from '@/sync/keys/conversionState.js'
import type { SyncResolver } from '@/sync/keys/resolver.js'
import type { BlobStore } from './blobStore.js'
import type { ByteStore } from './byteStore.js'
import { captureMediaFiles, type MediaCaptureDeps, type MediaCaptureResult } from './mediaCapture.js'
import { createAssetResolver, type AssetResolver } from './resolver.js'
import { drainUploads } from './uploadDrain.js'
import { isAssetBlockPresent, reconcileUploads } from './uploadReconcile.js'
import type { ByteUploadStatus, ByteUploadStore } from './uploadStore.js'

export interface MediaLaneDeps {
  readonly userId: string
  readonly byteStore: ByteStore
  readonly uploadStore: ByteUploadStore
  readonly blobStore: BlobStore
  readonly keys: Pick<SyncResolver, 'getMaterializability' | 'getCek' | 'getContentKeyHmac'>
  /** The server's workspace row read now (`fetchWorkspaceConversionState`). */
  readonly readLiveWorkspace: (workspaceId: string) => Promise<WorkspaceConversionRead>
  /** Whether this client may upload now, asked before each record. A record reached
   *  while it may not stays pending; uploading regardless would turn a demotion's 403
   *  into a permanent `failed`. */
  readonly canDrain: () => boolean
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
  /** Promote staged records whose block is present (a crash between the capture's
   *  commit and its promote), then drain. */
  reconcile(repo: Pick<Repo, 'load'>): Promise<void>
  counts(): Promise<Record<ByteUploadStatus, number>>
}

export const createMediaLanes = (deps: MediaLaneDeps): MediaLanes => {
  const { userId, byteStore, uploadStore: store, blobStore, keys, readLiveWorkspace, canDrain } = deps
  const keyDeps = {
    getMaterializability: keys.getMaterializability,
    getCek: keys.getCek,
    getContentKeyHmac: keys.getContentKeyHmac,
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
          try {
            // Also the per-record gate, so a demotion mid-pass defers the records after it.
            await drainUploads(userId, { store, byteStore, blobStore, readLiveWorkspace, ...keyDeps, isActiveUser: canDrain })
          } catch (error) {
            console.warn('[mediaLanes] drain failed', error)
          }
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
      await drain()
    },
    async counts() {
      const [staged, pending, failed] = await Promise.all(
        (['staged', 'pending', 'failed'] as const).map(status => store.countByStatus(userId, status)))
      return { staged, pending, failed }
    },
  }
}
