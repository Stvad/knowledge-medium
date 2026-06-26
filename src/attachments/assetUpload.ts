/**
 * The app-wired up-lane (design §9/§11) — the single place that assembles the
 * pure capture / drain / reconcile pieces with the real app deps and runs the
 * background lane SINGLE-OWNER across tabs.
 *
 *   - capture  — {@link captureMediaFromFiles}: the renderer's paste entry (the
 *     File-list plumbing is drop-ready, but only paste is wired today).
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
import { jsonPathForProperty } from '@/data/internals/typedBlockQuery.js'
import { supabase } from '@/services/supabase.js'
import { mediaHashProp } from './mediaBlock.js'
import { createSupabaseBlobStore, type BlobStore } from './blobStore.js'
import { getByteStore } from './byteStore.js'
import {
  captureMedia,
  DEFAULT_MAX_CAPTURE_BYTES,
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
    // Bind the drain to the user it was armed for: the deps (mode/key) + the
    // BlobStore session follow the ACTIVE account, so if a switch lands before this
    // lock body runs, draining userId's records under the new account could 403 and
    // wrongly quarantine them. Skip until userId is active again.
    await drainUploads(userId, { ...drainDepsFor(blobStore), isActiveUser: () => getActiveUserId() === userId })
  }).catch((err) => console.warn('[assetUpload] drain failed', err))
}

/**
 * "Did this asset block commit and sync?" — the reconciler's reap-vs-promote
 * pivot, and the load-bearing guard against reaping a real block's only bytes.
 *
 * A block absent from the materialized `blocks` table is NOT proof it never
 * committed. The reconciler runs after PowerSync's `hasSynced` (initial DOWNLOAD
 * settled), but the Layout-B observer materializes `blocks_synced → blocks`
 * asynchronously (throttled, off `hasSynced`), and several committed-and-synced
 * states sit in `blocks_synced` UNmaterialized at that moment: a locked-e2ee
 * workspace (no WK), undecryptable/quarantined ciphertext, a skip-stale row, or
 * just the observer lagging the download. `repo.load` (which reads only `blocks`)
 * reads all of these as absent — so reaping on that signal alone would delete the
 * only un-uploaded byte copy of a block the server already has. Treat presence in
 * EITHER table as committed.
 *
 * (`repo.load` filters soft-deletes; the `blocks_synced` fallback does not — an
 * undone-but-synced block still "committed", and it's the drain's soft-delete
 * handling, not the reaper, that decides whether to upload it.)
 */
export const isBlockCommitted = async (repo: Repo, id: string): Promise<boolean> => {
  if ((await repo.load(id)) != null) return true
  const synced = await repo.db.getOptional<{ id: string }>(
    `SELECT id FROM blocks_synced WHERE id = ? LIMIT 1`,
    [id],
  )
  return synced != null
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
      // Present == committed in `blocks` OR still-unmaterialized in `blocks_synced`
      // (locked e2ee / quarantined / skip-stale / observer-lag) — never reap those.
      isBlockPresent: (_ws, id) => isBlockCommitted(repo, id),
      // Locked e2ee withholds committed blocks from `blocks`, so an absent block
      // there is only conclusively-orphan when the workspace IS materializable.
      isWorkspaceMaterializable: async (ws) => (await getMaterializability(ws)) !== 'defer',
      // A still-existing (live or soft-deleted) carrier of the hash — typically
      // the asset block itself after an undone-not-redone paste — keeps the bytes.
      hashHasCarrier: async (ws, contentHash) => {
        const row = await repo.db.getOptional<{ x: number }>(
          `SELECT 1 AS x FROM blocks WHERE workspace_id = ? AND json_extract(properties_json, ?) = ? LIMIT 1`,
          [ws, jsonPathForProperty(mediaHashProp.name), contentHash],
        )
        return row != null
      },
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
 *  The renderer's paste entry point. The whole capture (stage → tx → promote) runs
 *  under the per-user MINT lock so a reconciler in another tab can't reap an
 *  in-flight capture (see {@link mintLockName}).
 *
 *  Files are read + captured ONE AT A TIME (bounded memory), and a grossly-oversize
 *  file is rejected by its declared `size` BEFORE `arrayBuffer()` — a multi-GB paste
 *  must not allocate its full size (× every file, the old `Promise.all`) just to be
 *  rejected by the post-read byteLength guard. `captureMedia` still applies the
 *  precise, mode-aware limit (the e2ee envelope overhead) on the bytes it reads. */
export const captureMediaFromFiles = async (
  repo: Repo,
  workspaceId: string,
  embedParentId: string,
  files: readonly File[],
): Promise<MediaCaptureResult[]> => {
  const deps = captureDepsFor(repo)
  const run = async (): Promise<MediaCaptureResult[]> => {
    const results: MediaCaptureResult[] = []
    for (const file of files) {
      if (file.size > DEFAULT_MAX_CAPTURE_BYTES) {
        results.push({ ok: false, reason: 'too-large' }) // reject without reading
        continue
      }
      const source: MediaSource = {
        bytes: new Uint8Array(await file.arrayBuffer()) as Uint8Array<ArrayBuffer>,
        mime: file.type || 'application/octet-stream',
        filename: file.name || undefined,
      }
      results.push(await captureMedia({ workspaceId, source, embedParentId }, deps))
    }
    return results
  }
  const userId = getActiveUserId()
  return userId ? withLock(mintLockName(userId), run) : run()
}
