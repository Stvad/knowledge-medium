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

import { getActiveUserId, isRemoteSyncActive, syncResolverForUser } from '@/data/repoProvider.js'
import type { Repo } from '@/data/repo.js'
import type { SyncResolver } from '@/sync/keys/resolver.js'
import { supabase } from '@/services/supabase.js'
import { showError } from '@/utils/toast.js'
import { remoteSyncGated } from './assetResolver.js'
import { createSupabaseBlobStore, type BlobStore } from './blobStore.js'
import { getByteStore } from './byteStore.js'
import { runSingleOwner, withLock } from './laneLock.js'
import { resolveCaptureMime } from './mediaBlock.js'
import { refreshUploadLaneStatus } from './uploadLaneStatus.js'
import {
  captureMedia,
  DEFAULT_MAX_CAPTURE_BYTES,
  type MediaCaptureDeps,
  type MediaCaptureFailure,
  type MediaCaptureResult,
  type MediaSource,
} from './mediaCapture.js'
import { drainUploads } from './uploadDrain.js'
import { recoverFailedUploads } from './uploadRecovery.js'
import { reconcileUploads } from './uploadReconcile.js'
import { getByteUploadStore } from './uploadStore.js'

let blobStoreSingleton: BlobStore | null = null
/** The app's Supabase-backed blob store, or null when there's nothing to upload to.
 *  Gated on the RUNTIME remote-sync state, NOT just `supabase != null`: a local-only
 *  session (the user opted out of remote at login, or toggled local-only) keeps a
 *  configured Supabase client but must upload NOTHING — capture stays in OPFS and the
 *  lane is a no-op (Codex P1). Re-checked each call (before the singleton) so the gate
 *  is dynamic across an account/mode switch. */
const getBlobStore = (): BlobStore | null => {
  if (!supabase || !isRemoteSyncActive()) return null
  if (!blobStoreSingleton) {
    const client = supabase
    blobStoreSingleton = createSupabaseBlobStore({
      client,
      getAccessToken: async () => (await client.auth.getSession()).data.session?.access_token ?? null,
    })
  }
  // Per-call gate (not just the arm-time check above): the drain captures this store
  // once and PUTs inside a lock that can outlive a flip to local-only. Wrapping makes
  // every op re-check `isRemoteSyncActive()` — a mid-lock flip routes to a remote miss
  // (transient → record stays pending), never a real upload during local-only.
  return remoteSyncGated(blobStoreSingleton)
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

// One per-user lock: the LANE lock makes the SLOW drain (uploads) single-owner
// across tabs, so N tabs don't multiply egress. Capture and the boot reconciler
// need NO lock — every up-lane op on the queue is idempotent (stage is an upsert,
// promote/delete are no-ops if absent) and the reconciler only PROMOTES (never the
// destructive reap that the old MINT lock existed to serialize against capture), so
// a capture racing a reconcile or another capture always converges.
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
    // Publish the post-drain FAILED count to the status indicator (a background
    // upload failure is otherwise silent — it's off the paste hot-path).
    await refreshUploadLaneStatus(getByteUploadStore(), userId)
  }).catch((err) => console.warn('[assetUpload] drain failed', err))
}

/** Boot recovery: promote `staged` records whose block has materialized (a crash
 *  between commit and the in-session promote), then drain. A `staged` record whose
 *  block isn't in `blocks` yet is LEFT for a later boot — never reaped (§16 GC owns
 *  orphan-byte reclamation; see {@link reconcileUploads}). Needs no lock: the
 *  promote is idempotent, so racing an in-flight capture's stage→promote converges. */
export const runUploadReconcile = async (userId: string, repo: Repo): Promise<void> => {
  // Surface any PRE-EXISTING failed records on boot — even in local-only, where the
  // drain below doesn't run (a failure from a prior remote session must still show).
  await refreshUploadLaneStatus(getByteUploadStore(), userId)
  if (!getBlobStore()) return
  await reconcileUploads(userId, {
    store: getByteUploadStore(),
    isBlockPresent: async (_ws, id) => (await repo.load(id)) != null,
  })
  armUploadDrain(userId)
}

/** How often a long-lived tab re-probes its `failed` records (design §9 "slow periodic
 *  sweep — a bodiless GET every few hours"), so a poisoned / occupied content path that
 *  frees still heals without waiting on a restart the tab may never get. Slow on purpose:
 *  each pass is only cheap GET probes over the (small) failed set. */
export const RECOVERY_SWEEP_INTERVAL_MS = 3 * 60 * 60 * 1000 // 3 hours

/** §9 failed-upload recovery: probe each `failed` record's content path and 3-way it
 *  (requeue a freed path → the drain re-uploads; clear an already-uploaded one; keep a
 *  poisoned one), then drain the requeued records — ALL single-owner under ONE lane-lock
 *  acquisition, so recovery + its drain are a single critical section (never a re-entrant
 *  lock request, which would deadlock). A no-op when Supabase isn't configured / the
 *  session is local-only (nothing to probe). Bound to `userId` (not the active account)
 *  end-to-end, like the drain, so an account switch mid-recovery can't act under the wrong
 *  session/keys.
 *
 *  Two per-trigger knobs (see {@link MediaUploadReconciler}):
 *   - `bypassBound` — re-drive a freed path even past the per-record bound (the slow sweep
 *     + explicit user retry, which must auto-heal a fixed client / raised limit); left off
 *     for the frequent triggers (boot / reconnect) so a shape-rejected body can't re-PUT
 *     on every reconnect.
 *   - `coalesce` — use the NON-blocking lane lock (skip if another tab already owns the
 *     lane) instead of queuing behind it. Set by the repeatable AUTOMATIC triggers
 *     (reconnect / periodic sweep) so N open tabs don't each run a full probe sweep in
 *     series (N× Storage egress); left off for boot + explicit Retry, which must actually
 *     run (a skip there would drop a real heal, not a redundant one). */
export const runUploadRecovery = (
  userId: string,
  opts: { bypassBound?: boolean; coalesce?: boolean } = {},
): void => {
  const blobStore = getBlobStore()
  if (!blobStore) return
  const resolver = syncResolverForUser(userId)
  const isActiveUser = () => getActiveUserId() === userId
  const pass = async (): Promise<void> => {
    await recoverFailedUploads(userId, {
      store: getByteUploadStore(),
      blobStore,
      ...laneKeyDeps(resolver),
      isActiveUser,
      bypassBound: opts.bypassBound,
    })
    // Upload whatever the probe re-queued (a freed path → pending). Same user-bound deps
    // as every other drain, so a mid-recovery switch can't drain under the wrong session.
    await drainUploads(userId, { ...drainDepsFor(blobStore, resolver), isActiveUser })
    // Publish the post-recovery FAILED count (recovery may have cleared / requeued some).
    await refreshUploadLaneStatus(getByteUploadStore(), userId)
  }
  const lane = opts.coalesce
    ? runSingleOwner(laneLockName(userId), pass) // skip if another tab owns the lane
    : withLock(laneLockName(userId), pass) // queue behind it — this pass must run
  void lane.catch((err) => console.warn('[assetUpload] recovery failed', err))
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
  drain: armUploadDrain,
})

/** Read each File's bytes and capture them as content-addressed media blocks (under
 *  the workspace ASSETS container). Returns one result per file — the caller builds +
 *  places the `((assetBlockId))` references. Needs no lock: every queue op is idempotent
 *  and the reconciler only promotes, so a concurrent capture/reconcile converges.
 *
 *  Files are read + captured ONE AT A TIME (bounded memory), and a grossly-oversize
 *  file is rejected by its declared `size` BEFORE `arrayBuffer()` — a multi-GB paste
 *  must not allocate its full size (× every file, the old `Promise.all`) just to be
 *  rejected by the post-read byteLength guard. `captureMedia` still applies the
 *  precise, mode-aware limit (the e2ee envelope overhead) on the bytes it reads. */
export const captureMediaFromFiles = async (
  repo: Repo,
  workspaceId: string,
  files: readonly File[],
): Promise<MediaCaptureResult[]> => {
  // Snapshot the lane context at the paste boundary: the user, and that user's §6
  // resolver. Capture touches no remote session (it only stages + writes the block
  // via `repo`), so once bound it is fully self-consistent — a mid-capture account
  // switch can't split it across accounts.
  const userId = getActiveUserId()
  if (!userId) return files.map(() => ({ ok: false, reason: 'no-user' as const }))
  const deps = captureDepsFor(repo, { userId, resolver: syncResolverForUser(userId) })
  const results: MediaCaptureResult[] = []
  for (const file of files) {
    if (file.size > DEFAULT_MAX_CAPTURE_BYTES) {
      results.push({ ok: false, reason: 'too-large' }) // reject without reading
      continue
    }
    const bytes = new Uint8Array(await file.arrayBuffer()) as Uint8Array<ArrayBuffer>
    const source: MediaSource = {
      bytes,
      // Derive the MIME from the bytes when File.type is missing/generic — a typeless
      // image must still render inline, and the stored MIME must be a function of the
      // bytes so it can't disagree with a content-dedup'd row (Codex P2).
      mime: resolveCaptureMime(file.type, bytes),
      filename: file.name || undefined,
    }
    results.push(await captureMedia({ workspaceId, source }, deps))
  }
  return results
}

/** User-facing message per capture failure. `captureMediaFromFiles` returns failures
 *  as RESOLVED `{ok:false}` values (not throws), so without this a paste that's
 *  rejected (oversize, locked workspace, …) does nothing visible — the user believes
 *  it worked. */
const CAPTURE_FAILURE_MESSAGE: Record<MediaCaptureFailure, string> = {
  'no-user': 'Sign in to attach media.',
  empty: 'That file is empty — nothing to attach.',
  'too-large': 'That file is too large to attach.',
  'unsupported-mime': 'That file type can’t be attached.',
  'workspace-locked': 'Unlock this workspace to attach media.',
  'no-content-key': 'Re-paste your workspace key to attach media.',
}

/** Toast the distinct failure reasons from a (possibly multi-file) capture. Call on
 *  the resolved results of {@link captureMediaFromFiles} so a silently-rejected paste
 *  becomes visible feedback. De-dupes identical reasons across files. */
export const reportCaptureFailures = (results: readonly MediaCaptureResult[]): void => {
  const reasons = new Set(results.flatMap(r => (r.ok ? [] : [r.reason])))
  for (const reason of reasons) showError(CAPTURE_FAILURE_MESSAGE[reason])
}
