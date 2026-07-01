/**
 * The §9 failed-upload recovery actor — opportunistic self-heal for a `failed`
 * up-lane record (design §9/§17).
 *
 * PRINCIPLE (user): if we saved the file's bytes locally, it's on us to get them
 * uploaded — a failed upload must not require a manual re-paste. The drain
 * ({@link import('./uploadDrain.js').drainUploads}) bounds retries by attempt/age then
 * quarantines to `failed`, which is inert: nothing re-drains it. This actor un-sticks
 * such records WITHOUT re-entering the hot correction loop the `failed` state exists to
 * stop.
 *
 * WHY A PROBE PASS, NOT A BLIND RE-`pending`: a blind `failed → pending` would make the
 * drain re-UPLOAD the full sealed bytes on every recovery trigger even when the content
 * path is occupied/poisoned (`put` → 409 → verify → back to `failed`) — the exact egress
 * §9's "cheap bodiless GET" exists to avoid, and against a persistent poisoner it's a
 * PUT per trigger, not a GET. Instead we do ONE cheap direct RLS GET of the content path
 * ({@link BlobStore.probe}) and branch (§9/§17):
 *   - ABSENT (404, path free)     → `requeue` failed→pending; the existing drain uploads
 *                                   the local bytes. The ONLY branch that costs a PUT,
 *                                   and it reuses the already-bounded drain rather than a
 *                                   second upload path.
 *   - PRESENT + hash-VERIFIES     → another device already materialized our content →
 *                                   `delete` the record; NO re-upload. (Drops the
 *                                   durability floor to best-effort like any replicated
 *                                   byte — the accepted §9 tradeoff.)
 *   - PRESENT + hash-MISMATCHES /
 *     undecodable                 → still poisoned (§17) → stay `failed`; never a PUT.
 *   - transient GET (offline/5xx/
 *     denied), not-materializable
 *     (locked/unpinned/signed-out),
 *     or wrong active account      → DEFER (no state change); the next sparse trigger
 *                                    re-probes. No attempt burn, no PUT.
 *
 * WHY THE DOWN-LANE CAN'T DO THIS: the down-lane fetches bytes that are ABSENT locally;
 * a `failed` record's bytes are PRESENT locally, so the down-lane never visits it. This
 * re-attempt sweep is the up-lane's own (design §9).
 *
 * BOUND (so a persistent poisoner / shape-reject bug can't re-drive forever): the ONLY
 * expensive branch (absent → requeue → PUT) is gated by the record's
 * {@link ByteUploadRecord.recoveryAttempts} counter (bumped by `requeue`). Past
 * `maxRecoveryAttempts` the cheap probe still runs (it still heals the "uploaded
 * elsewhere" case) but no longer re-drives — the record stays surfaced-for-discard. An
 * explicit USER retry (`force`) bypasses the bound: the user asked, like redo treating
 * `failed` as a fresh trigger (§9).
 *
 * PURE: like {@link import('./uploadReconcile.js').reconcileUploads} /
 * {@link import('./uploadDrain.js').drainUploads}, this only reads the queue + probes /
 * decodes REMOTE bytes and mutates the queue (`requeue` / `delete`). It NEVER touches the
 * LOCAL byte store — a `failed` record's local bytes are the only copy + the self-heal
 * source and stay put (the eviction-exemption invariant); only an explicit user discard
 * releases them (content-refcount-gated, §8/§9/§16). It does NOT run the drain itself; the
 * app wiring ({@link import('./assetUpload.js').runUploadRecovery}) drains the requeued
 * records after this pass, inside one lane lock.
 */

import { decodeBytes } from '@/sync/byteTransform.js'
import { verifyContentHash } from '@/sync/crypto/contentHash.js'
import { materializabilityToMode, type GetCek, type GetMaterializability } from '@/sync/transform.js'
import type { BlobStore } from './blobStore.js'
import type { ByteUploadRecord, ByteUploadStore } from './uploadStore.js'

/** How many times recovery will re-drive one record out of `failed` before it stops
 *  (the cheap probe keeps running past this; only the PUT-costing re-drive stops).
 *  Small on purpose — a genuinely-freed path heals on the first re-drive; a persistent
 *  poisoner / shape-reject body must NOT re-PUT on every sparse trigger. */
const DEFAULT_MAX_RECOVERY_ATTEMPTS = 3

export interface UploadRecoveryDeps {
  readonly store: ByteUploadStore
  readonly blobStore: BlobStore
  /** The three-valued materializability (same source the drain + read lane use):
   *  decrypt → e2ee (verify with the CEK), copy → plaintext, defer → can't act → defer. */
  readonly getMaterializability: GetMaterializability
  /** The workspace key for the e2ee AEAD-open of a PRESENT object. */
  readonly getCek: GetCek
  /** Is the QUEUED user still the active account? The probe / decode ride the active
   *  session + resolve keys against the active user, so a mid-recovery account switch
   *  must not verify/re-drive userA's record under userB. Defaults to always-active. */
  readonly isActiveUser?: () => boolean
  readonly maxRecoveryAttempts?: number
  /** Explicit user retry: bypass the per-record re-drive bound (the user asked — §9,
   *  like redo treating `failed` as a fresh trigger). */
  readonly force?: boolean
}

export interface RecoverySummary {
  /** failed → pending (path free) — the drain uploads these next. */
  readonly requeued: number
  /** deleted (already uploaded elsewhere; hash-verified). */
  readonly cleared: number
  /** left `failed` — present but poisoned/undecodable (§17). */
  readonly poisoned: number
  /** left `failed` — transient probe, not materializable, or wrong active account. */
  readonly deferred: number
  /** left `failed` — path free but the re-drive bound is spent (persistent failure). */
  readonly exhausted: number
}

type RecoverOutcome = keyof RecoverySummary

interface RecoverOneCtx {
  readonly store: ByteUploadStore
  readonly blobStore: BlobStore
  readonly getMaterializability: GetMaterializability
  readonly getCek: GetCek
  readonly isActiveUser: () => boolean
  readonly maxRecoveryAttempts: number
  readonly force: boolean
}

const recoverOne = async (
  userId: string,
  rec: ByteUploadRecord,
  ctx: RecoverOneCtx,
): Promise<RecoverOutcome> => {
  // (0) Bind to the active account (same gate as the drain): a probe/decode under the
  //     wrong session could 403 or open with the wrong key.
  if (!ctx.isActiveUser()) return 'deferred'

  // (1) Can we decode for this workspace right now? A PRESENT object needs the key to
  //     hash-verify, and the absent branch's re-drive can only encode-to-upload when
  //     materializable — so a locked / unpinned / signed-out workspace defers uniformly.
  const mode = materializabilityToMode(await ctx.getMaterializability(rec.workspaceId))
  if (mode === null) return 'deferred'

  // (2) The cheap probe. A definitive 404 → null (path free); any other error throws →
  //     transient (offline / 5xx / RLS-denied) → defer, never a PUT.
  let stored: Uint8Array<ArrayBuffer> | null
  try {
    stored = await ctx.blobStore.probe(rec.workspaceId, rec.contentKey)
  } catch {
    return 'deferred'
  }

  // (3a) ABSENT → the path is free. Re-drive via the drain (requeue failed→pending)
  //      UNLESS the bound is spent (and this isn't an explicit user retry). The `requeue`
  //      CAS on `stagedAt` drops the write if a re-paste re-armed the record mid-probe.
  if (stored === null) {
    if (!ctx.force && (rec.recoveryAttempts ?? 0) >= ctx.maxRecoveryAttempts) return 'exhausted'
    await ctx.store.requeue(userId, rec.assetBlockId, rec.stagedAt)
    return 'requeued'
  }

  // (3b) PRESENT → decode + hash-verify against our own content hash (the §5.1 / §17
  //      check the drain's 409-verify runs — an existing object is untrusted).
  let decoded: Uint8Array<ArrayBuffer>
  try {
    decoded = await decodeBytes(stored, mode, ctx.getCek, {
      contentHash: rec.contentHash,
      workspaceId: rec.workspaceId,
    })
  } catch {
    return 'poisoned' // present but undecodable (corrupt / wrong envelope) — §17, stay failed
  }
  if (await verifyContentHash(decoded, rec.contentHash)) {
    // Already materialized on another device — clear the record, DON'T re-upload. The
    // local bytes stay (now eviction-eligible like any replicated byte, §9 tradeoff).
    await ctx.store.delete(userId, rec.assetBlockId)
    return 'cleared'
  }
  return 'poisoned' // present but wrong content — poisoned path (§17), stay failed
}

/** Probe + 3-way every `failed` record for `userId` (design §9/§17). Sequential — the
 *  failed set is small and this is a background sweep; the app wiring runs it
 *  single-owner (lane lock) and drains the requeued records afterward. */
export const recoverFailedUploads = async (
  userId: string,
  deps: UploadRecoveryDeps,
): Promise<RecoverySummary> => {
  const ctx: RecoverOneCtx = {
    store: deps.store,
    blobStore: deps.blobStore,
    getMaterializability: deps.getMaterializability,
    getCek: deps.getCek,
    isActiveUser: deps.isActiveUser ?? (() => true),
    maxRecoveryAttempts: deps.maxRecoveryAttempts ?? DEFAULT_MAX_RECOVERY_ATTEMPTS,
    force: deps.force ?? false,
  }

  const failed = await deps.store.listByStatus(userId, 'failed')
  const counts: Record<RecoverOutcome, number> = {
    requeued: 0,
    cleared: 0,
    poisoned: 0,
    deferred: 0,
    exhausted: 0,
  }
  for (const rec of failed) counts[await recoverOne(userId, rec, ctx)] += 1
  return counts
}
