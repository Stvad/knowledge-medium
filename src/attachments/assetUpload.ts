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

import { getActiveUserId, syncResolverForUser } from '@/data/repoProvider.js'
import type { Repo } from '@/data/repo.js'
import type { SyncResolver } from '@/sync/keys/resolver.js'
import { supabase } from '@/services/supabase.js'
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

/** Boot-time stamp recorded on each staged record (set once per page load). The
 *  promote-only reconciler no longer uses it (it never reaps), so it is currently
 *  vestigial — kept as a cheap per-record provenance marker for §16 GC / debugging. */
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

/** The §6 encode/key accessors bound to ONE user's resolver. The up-lane snapshots
 *  this at its entry boundary (capture / drain), so an account switch mid-operation
 *  can't make it read a DIFFERENT user's keys — "bind the lane to the user it was
 *  armed for" in one place, instead of scattered `getActiveSyncResolver()` reads. A
 *  null resolver (signed out) fails closed (defer / no key). */
const laneKeyDeps = (resolver: SyncResolver | null) => ({
  getMaterializability: (ws: string) => resolver?.getMaterializability(ws) ?? 'defer',
  getCek: (ws: string) => resolver?.getCek(ws) ?? Promise.resolve(null),
  getContentKeyHmac: (ws: string) => resolver?.getContentKeyHmac(ws) ?? Promise.resolve(null),
})

/** The bound identity an up-lane operation carries end-to-end: the user whose repo
 *  / byte store / queue it touches, plus THAT user's §6 resolver (not the active
 *  one). Snapshotted once at the boundary; never re-read from ambient mid-flight. */
interface LaneContext {
  readonly userId: string
  readonly resolver: SyncResolver | null
}

const drainDepsFor = (blobStore: BlobStore, resolver: SyncResolver | null) => ({
  store: getByteUploadStore(),
  byteStore: getByteStore(),
  blobStore,
  ...laneKeyDeps(resolver),
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
  // Bind the encode/key deps to `userId` (the user the drain was armed for), not
  // the active account. The upload SESSION still rides the one active Supabase
  // client, so the PUT must run only while `userId` is active (else a 403 under
  // another account) — hence the per-record `isActiveUser` gate as well.
  const resolver = syncResolverForUser(userId)
  void withLock(laneLockName(userId), async () => {
    await drainUploads(userId, {
      ...drainDepsFor(blobStore, resolver),
      isActiveUser: () => getActiveUserId() === userId,
    })
  }).catch((err) => console.warn('[assetUpload] drain failed', err))
}

/** Boot recovery: promote `staged` records whose block has materialized (a crash
 *  between commit and the in-session promote), then drain. A `staged` record whose
 *  block isn't in `blocks` yet is LEFT for a later boot — never reaped (§16 GC owns
 *  orphan-byte reclamation; see {@link reconcileUploads}). Runs under the MINT lock
 *  so it can't race an in-flight capture's stage→promote. */
export const runUploadReconcile = async (userId: string, repo: Repo): Promise<void> => {
  if (!getBlobStore()) return
  await withLock(mintLockName(userId), () =>
    reconcileUploads(userId, {
      store: getByteUploadStore(),
      isBlockPresent: async (_ws, id) => (await repo.load(id)) != null,
    }),
  )
  // Drain separately under the lane lock — never hold the mint lock across uploads.
  armUploadDrain(userId)
}

const captureDepsFor = (repo: Repo, ctx: LaneContext): MediaCaptureDeps => ({
  repo,
  byteStore: getByteStore(),
  uploadStore: getByteUploadStore(),
  // Everything is bound to the SAME user (`ctx.userId`) that owns `repo`: the
  // block lands in `repo`, and its OPFS bytes + queue record + key/mode all key off
  // ctx — so an account switch mid-capture can't split them across accounts.
  getUserId: () => ctx.userId,
  ...laneKeyDeps(ctx.resolver),
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
  // Snapshot the lane context at the paste boundary: the user, and that user's §6
  // resolver. Capture touches no remote session (it only stages + writes the block
  // via `repo`), so once bound it is fully self-consistent — a mid-capture account
  // switch can't split it across accounts, and there is nothing to abort for.
  const userId = getActiveUserId()
  if (!userId) return files.map(() => ({ ok: false, reason: 'no-user' as const }))
  const deps = captureDepsFor(repo, { userId, resolver: syncResolverForUser(userId) })
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
  return withLock(mintLockName(userId), run)
}
