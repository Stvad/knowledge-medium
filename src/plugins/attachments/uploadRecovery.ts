/**
 * The §9 failed-upload recovery actor — the brain behind the user's "Retry" on a
 * `failed` up-lane record (design §9/§17).
 *
 * PRINCIPLE (user): if we saved the file's bytes locally, it's on us to get them
 * uploaded — a failed upload must not require a manual re-paste. The drain
 * ({@link import('./uploadDrain.js').drainUploads}) bounds retries by attempt/age then
 * quarantines to `failed`, which is inert: nothing re-drains it. This actor un-sticks
 * such records WITHOUT re-entering the hot correction loop the `failed` state exists to
 * stop.
 *
 * USER-TRIGGERED, NOT AN AUTOMATIC SWEEP. Recovery only ever touches the QUARANTINED set:
 * a TRANSIENT failure (offline / 5xx / token) stays `pending` — the drain keeps it there and
 * the reconnect/refocus sweep re-drives it automatically — and only crosses into `failed` if it
 * keeps failing past the drain's ~7-day AGE backstop ({@link import('./uploadDrain.js')}
 * `deferTransientOrFail`). So `failed` holds mostly the permanent-ish rejects (poisoned path,
 * shape-rejected body, 413, not-a-writer) plus that rare aged-out transient, and for those the
 * right — and codebase-consistent — UX is to SURFACE them (the §9 diagnostics warning) and let
 * the user hit Retry, exactly as block-sync rejections surface via `ps_crud_rejected`. The user
 * is the rate limiter, so there is no automatic re-drive bound: this pass runs when they ask, and
 * the probe below makes even a "Retry all" safe against poisoned paths (a probe + hash-verify,
 * never a blind re-PUT).
 *
 * WHY A PROBE PASS, NOT A BLIND RE-`pending`: a blind `failed → pending` would make the
 * drain re-UPLOAD the full sealed bytes even when the content path is occupied/poisoned
 * (`put` → 409 → verify → back to `failed`) — the exact wasted full PUT per Retry §9's probe
 * exists to avoid. Instead we do ONE direct RLS GET of the content path
 * ({@link BlobStore.probe}) — a 404 when the path is free (no body); the object's bytes when
 * it's occupied (which we have to read anyway to hash-verify) — and branch (§9/§17):
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
 *     unknown), not-materializable
 *     (locked/unpinned/signed-out),
 *     no live session token, or
 *     wrong active account         → DEFER (no state change); a later Retry re-probes.
 *                                    No attempt burn, no PUT.
 *
 * WHY THE DOWN-LANE CAN'T DO THIS: the down-lane fetches bytes that are ABSENT locally;
 * a `failed` record's bytes are PRESENT locally, so the down-lane never visits it. This
 * re-attempt is the up-lane's own (design §9).
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
  /** The active session's access token (the same getter the blob store PUTs with); null
   *  ⟹ no live Supabase session. Required to TRUST a probe: with no token the read rides
   *  the anon role and an RLS-denied download is 404-shaped (existence-hiding), so a 404
   *  can't be read as "path free" — and the tokenless drain couldn't upload anyway. So a
   *  missing token DEFERS (keeps the record `failed` + its §9 warning) rather than requeue
   *  it into invisible `pending`. Defaults to always-authed (tests opt in). */
  readonly getAccessToken?: () => Promise<string | null>
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
}

type RecoverOutcome = keyof RecoverySummary

interface RecoverOneCtx {
  readonly store: ByteUploadStore
  readonly blobStore: BlobStore
  readonly getMaterializability: GetMaterializability
  readonly getCek: GetCek
  readonly isActiveUser: () => boolean
  readonly getAccessToken: () => Promise<string | null>
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

  // (1b) A live session is required to TRUST the probe. With no token the read rides the anon
  //      role, where an RLS-denied download is 404-shaped (Storage hides existence) — so a 404
  //      can't be read as "path free", and requeuing off it would clear the §9 warning while the
  //      equally-tokenless drain can't actually upload (its PUT 401s → transient → back to
  //      invisible `pending`, age reset, bytes still only local). Defer until authed — no probe.
  if ((await ctx.getAccessToken()) === null) return 'deferred'

  // (2) The probe, now that (0)/(1)/(1b) guarantee the active account, a materializable
  //     workspace, AND a live session. A definitive 404 → null (path free); any other error
  //     throws → transient (offline / 5xx / unknown) → defer, never a PUT. A DENIED read is
  //     404-shaped, but with (1b) requiring a token the only denial left is the narrow
  //     account-switch race — the probe ran under userB and 404'd on userA's RLS-hidden path —
  //     which the (2b) re-check catches before it can requeue. So a surviving 404 here means our
  //     OWN authenticated read found the path free, not that we couldn't see it.
  let stored: Uint8Array<ArrayBuffer> | null
  try {
    stored = await ctx.blobStore.probe(rec.workspaceId, rec.contentKey)
  } catch {
    return 'deferred'
  }

  // (2b) The probe rode the AMBIENT session; re-confirm the queued user is still active before
  //      acting on its result, so an account switch during the probe can't requeue/clear
  //      userA's record off a read that ran (and maybe 404'd on RLS) under userB.
  if (!ctx.isActiveUser()) return 'deferred'

  // (3a) ABSENT → the path is free. Re-drive via the drain (requeue failed→pending); the
  //      `requeue` CAS on `stagedAt` drops the write if a re-paste re-armed the record
  //      mid-probe.
  if (stored === null) {
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
    // `delete` intentionally skips the `stagedAt` CAS the requeue/markFailed writes use:
    // a re-paste that re-armed this record mid-probe carries the SAME content (assetBlockId
    // is a UUIDv5 of workspace+contentKey, which derives from the hash), and we just
    // hash-verified that content is durably on the server — so deleting the re-armed
    // record is correct (nothing left to upload; a later `promote` no-ops). Mirrors the
    // drain's own un-CAS'd dedup-delete (uploadDrain.ts). Content-addressed ids are the
    // load-bearing invariant here — revisit if id derivation ever changes.
    await ctx.store.delete(userId, rec.assetBlockId)
    return 'cleared'
  }
  return 'poisoned' // present but wrong content — poisoned path (§17), stay failed
}

/** Probe + 3-way every `failed` record for `userId` (design §9/§17). Sequential — the
 *  failed set is small and this runs on an explicit user Retry; the app wiring runs it
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
    getAccessToken: deps.getAccessToken ?? (async () => 'authed'),
  }

  const failed = await deps.store.listByStatus(userId, 'failed')
  const counts: Record<RecoverOutcome, number> = {
    requeued: 0,
    cleared: 0,
    poisoned: 0,
    deferred: 0,
  }
  for (const rec of failed) counts[await recoverOne(userId, rec, ctx)] += 1
  return counts
}
