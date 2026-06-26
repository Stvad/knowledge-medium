/**
 * The app-wired up-lane (design §9/§11) — the single place that assembles the
 * pure capture / drain / reconcile pieces with the real app deps and runs the
 * background lane SINGLE-OWNER across tabs.
 *
 *   - capture  — {@link captureMediaFromFiles}: the renderer's paste/drop entry.
 *   - drain    — {@link armUploadDrain}: fire-and-forget after a capture.
 *   - reconcile — {@link runUploadReconcile}: at app start, AFTER PowerSync settles.
 *
 * The byte store, upload queue, and Supabase blob store are process singletons so
 * capture (write), the resolver (read), the drain, and the reconciler all share
 * one view. The mode/key deps are re-read from the ACTIVE user's §6 resolver per
 * call so an account switch is reflected without rebuilding anything.
 *
 * SINGLE-OWNER: the drain + reconcile run inside a per-user `navigator.locks`
 * lock, so with N tabs open exactly one runs the lane at a time (the upload is
 * idempotent anyway, but this avoids N× egress). Capture stays per-tab.
 */

import { getActiveSyncResolver, getActiveUserId } from '@/data/repoProvider.js'
import type { Repo } from '@/data/repo.js'
import { supabase } from '@/services/supabase.js'
import { createSupabaseBlobStore, type BlobStore } from './blobStore.js'
import { getByteStore } from './byteStore.js'
import {
  captureMediaFiles,
  type MediaCaptureDeps,
  type MediaCaptureResult,
  type MediaSource,
} from './mediaCapture.js'
import { drainUploads } from './uploadDrain.js'
import { reconcileUploads } from './uploadReconcile.js'
import { getByteUploadStore } from './uploadStore.js'

/** Boot-time generation stamp — set once per page load. The reconciler reaps
 *  `staged` records only from strictly older boots, so this distinguishes this
 *  session's in-flight captures from a dead session's orphans. */
export const uploadGeneration = Date.now()

let blobStoreSingleton: BlobStore | null = null
/** The app's Supabase-backed blob store, or null when Supabase isn't configured
 *  (local-only build — nothing to upload to, so the lane is a no-op). */
const getBlobStore = (): BlobStore | null => {
  if (blobStoreSingleton) return blobStoreSingleton
  if (!supabase) return null
  const client = supabase
  blobStoreSingleton = createSupabaseBlobStore({
    client,
    getAccessToken: async () => (await client.auth.getSession()).data.session?.access_token ?? null,
  })
  return blobStoreSingleton
}

// Mode/key deps from the active user's §6 resolver; signed out → fail closed.
const getMaterializability = (ws: string) =>
  getActiveSyncResolver()?.getMaterializability(ws) ?? 'defer'
const getCek = (ws: string) => getActiveSyncResolver()?.getCek(ws) ?? Promise.resolve(null)
const getContentKeyHmac = (ws: string) =>
  getActiveSyncResolver()?.getContentKeyHmac(ws) ?? Promise.resolve(null)

const drainDepsFor = (blobStore: BlobStore) => ({
  store: getByteUploadStore(),
  byteStore: getByteStore(),
  blobStore,
  getMaterializability,
  getCek,
})

/** Run `work` holding a named lock — falls back to running directly where
 *  `navigator.locks` is absent. */
const withLock = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  return locks?.request ? locks.request(name, work) : work()
}

// TWO per-user locks, deliberately separate:
//  - the MINT lock serializes the fast "create/reap a staged record + check block
//    presence" operations — capture (stage → tx → promote) AND the reconciler's
//    reap. Holding it around the WHOLE capture is what prevents a later-booted
//    tab's reconciler from reaping THIS tab's in-flight capture (its block is
//    absent only because its tx hasn't committed yet — a generation stamp alone
//    can't tell that live-but-earlier tab from a dead prior session).
//  - the LANE lock serializes the SLOW drain (uploads). Kept distinct so a capture
//    never blocks on another tab's long upload backlog.
const mintLockName = (userId: string) => `km-asset-mint:${userId}`
const laneLockName = (userId: string) => `km-asset-upload-lane:${userId}`

/** Fire-and-forget drain of the active user's pending uploads (after a capture).
 *  Single-owner (lane lock); a no-op when Supabase isn't configured. */
export const armUploadDrain = (userId: string): void => {
  const blobStore = getBlobStore()
  if (!blobStore) return
  void withLock(laneLockName(userId), async () => {
    await drainUploads(userId, drainDepsFor(blobStore))
  }).catch((err) => console.warn('[assetUpload] drain failed', err))
}

/** Boot recovery: promote `staged` records whose block committed, reap orphans
 *  (under the MINT lock so it can't reap an in-flight capture), then drain. MUST
 *  be called only AFTER PowerSync reports initial sync settled (so an absent block
 *  is truly-absent, not unhydrated). */
export const runUploadReconcile = async (userId: string, repo: Repo): Promise<void> => {
  if (!getBlobStore()) return
  await withLock(mintLockName(userId), () =>
    reconcileUploads(userId, {
      store: getByteUploadStore(),
      byteStore: getByteStore(),
      isBlockPresent: async (_ws, id) => (await repo.load(id)) != null,
      currentGeneration: uploadGeneration,
    }),
  )
  // Drain separately under the lane lock — never hold the mint lock across uploads.
  armUploadDrain(userId)
}

const captureDepsFor = (repo: Repo): MediaCaptureDeps => ({
  repo,
  byteStore: getByteStore(),
  uploadStore: getByteUploadStore(),
  getUserId: getActiveUserId,
  getMaterializability,
  getContentKeyHmac,
  generation: uploadGeneration,
  drain: armUploadDrain,
})

/** Read each File's bytes and capture them as media blocks under `embedParentId`.
 *  The renderer's paste/drop entry point. The whole capture (stage → tx → promote)
 *  runs under the per-user MINT lock so a reconciler in another tab can't reap an
 *  in-flight capture (see {@link mintLockName}). */
export const captureMediaFromFiles = async (
  repo: Repo,
  workspaceId: string,
  embedParentId: string,
  files: readonly File[],
): Promise<MediaCaptureResult[]> => {
  const sources: MediaSource[] = await Promise.all(
    [...files].map(async (file) => ({
      bytes: new Uint8Array(await file.arrayBuffer()) as Uint8Array<ArrayBuffer>,
      mime: file.type || 'application/octet-stream',
      filename: file.name || undefined,
    })),
  )
  const run = () => captureMediaFiles(workspaceId, embedParentId, sources, captureDepsFor(repo))
  const userId = getActiveUserId()
  return userId ? withLock(mintLockName(userId), run) : run()
}
