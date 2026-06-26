/**
 * The up-lane drain (design §9/§11) — uploads `pending` byte records to Storage.
 *
 * For each pending record: read the PLAINTEXT bytes from the OPFS byte store,
 * encode them AT DRAIN TIME (passthrough for plaintext, AES-GCM seal for e2ee —
 * the key is only needed here, not at capture), and upload the result directly to
 * `<ws>/<contentKey>` (§10.1, RLS-gated, first-write-wins). A confirmed upload
 * DELETES the record; the bytes stay in OPFS as the local render replica.
 *
 * Failure handling (the §9/§17 bounded-correction rule):
 *   - `defer` materializability (locked / unpinned / signed out) → leave `pending`,
 *     no attempt burn; the next sweep retries once the workspace is materializable.
 *   - PERMANENT BlobPutError (403/404/413, the advisory hint) → `failed` at once.
 *   - any other failure (transient 4xx/5xx/network, an encode error, a stray
 *     non-enumerated permanent) → bump attempts and retry, BUT bound by attempt
 *     count AND age so a never-enumerated-permanent can't hot-loop forever — once
 *     either bound is hit, → `failed`. (`permanent` only quarantines SOONER.)
 *   - local bytes missing (OPFS eviction before the upload drained) → `failed`:
 *     unrecoverable from the queue; §9 recovery / a re-paste re-stages with bytes.
 *
 * SINGLE-OWNER: this is a background lane. The caller (Phase 5d) serializes it
 * under a `navigator.locks` lock so two tabs never drain concurrently; the upload
 * is idempotent (upsert:false, 409 = success) so even a racing drain is safe.
 *
 * SCOPE — undo-before-upload: this drain does NOT check whether the asset block is
 * still live before uploading. A paste-then-undo can leave a `pending` record
 * whose block is soft-deleted; this drain uploads its bytes anyway. That is
 * harmless and deliberate — objects are immutable, content-addressed, and
 * reference-permanent (§16 GC reclaims an unreferenced object). Adding an inline
 * block-presence check here would couple the lane to the DB and reintroduce a
 * hydration race (absent-because-unsynced vs absent-because-undone). Orphan
 * cleanup is the boot reconciler's (5d) + §16 GC's job, gated on the settled
 * checkpoint — not this hot path. (Divergence from design.html's "drain
 * block-exists-before-PUT" note; correctness-equivalent given immutable objects.)
 */

import { encodeBytes } from '../sync/byteTransform.js'
import type { GetCek, GetMaterializability, Materializability, SyncMode } from '../sync/transform.js'
import { BlobPutError, type BlobStore } from './blobStore.js'
import type { ByteStore } from './byteStore.js'
import type { ByteUploadRecord, ByteUploadStore } from './uploadStore.js'

/** Default retry bounds. Generous enough to ride out a long offline stretch, but
 *  finite so a non-enumerated permanent failure can't retry forever (§9/§17). */
const DEFAULT_MAX_ATTEMPTS = 8
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export interface UploadDrainDeps {
  readonly store: ByteUploadStore
  readonly byteStore: ByteStore
  readonly blobStore: BlobStore
  /** The three-valued materializability (same source the read lane uses): decrypt
   *  → seal e2ee, copy → passthrough, defer → not uploadable yet. */
  readonly getMaterializability: GetMaterializability
  /** The workspace key for the e2ee seal. */
  readonly getCek: GetCek
  readonly now?: () => number
  readonly maxAttempts?: number
  readonly maxAgeMs?: number
}

export interface DrainSummary {
  readonly uploaded: number
  readonly failed: number
  readonly deferred: number
  readonly retried: number
}

type DrainOutcome = 'uploaded' | 'failed' | 'deferred' | 'retried'

/** Map the read-lane's three-valued materializability to an encode mode, or
 *  `null` when the workspace can't be materialized right now (defer / unexpected
 *  — both leave the record pending, never an attempt burn). */
const encodeModeFor = (m: Materializability): SyncMode | null => {
  switch (m) {
    case 'decrypt':
      return 'e2ee'
    case 'copy':
      return 'none'
    default:
      return null
  }
}

interface DrainOneCtx {
  readonly store: ByteUploadStore
  readonly byteStore: ByteStore
  readonly blobStore: BlobStore
  readonly getMaterializability: GetMaterializability
  readonly getCek: GetCek
  readonly now: () => number
  readonly maxAttempts: number
  readonly maxAgeMs: number
}

/** Bounded-retry decision for a non-permanent failure: bump the attempt unless a
 *  bound (attempt count OR age) is reached, in which case quarantine. */
const retryOrFail = async (
  userId: string,
  rec: ByteUploadRecord,
  ctx: DrainOneCtx,
): Promise<DrainOutcome> => {
  const exhausted = rec.attempts + 1 >= ctx.maxAttempts || ctx.now() - rec.stagedAt > ctx.maxAgeMs
  if (exhausted) {
    await ctx.store.markFailed(userId, rec.assetBlockId)
    return 'failed'
  }
  await ctx.store.recordAttempt(userId, rec.assetBlockId)
  return 'retried'
}

const drainOne = async (
  userId: string,
  rec: ByteUploadRecord,
  ctx: DrainOneCtx,
): Promise<DrainOutcome> => {
  // (1) Can we encode for this workspace right now? defer/unexpected → leave pending.
  const mode = encodeModeFor(await ctx.getMaterializability(rec.workspaceId))
  if (mode === null) return 'deferred'

  // (2) The plaintext bytes (capture wrote them before staging). A read THROW is
  //     transient (retry); a clean MISS means the bytes were evicted → quarantine.
  let plaintext: Uint8Array<ArrayBuffer> | null
  try {
    plaintext = await ctx.byteStore.get(userId, rec.workspaceId, rec.contentKey)
  } catch {
    return retryOrFail(userId, rec, ctx)
  }
  if (!plaintext) {
    await ctx.store.markFailed(userId, rec.assetBlockId)
    return 'failed'
  }

  // (3) Encode at drain + direct upload. Confirmed → delete the record.
  try {
    const sealed = await encodeBytes(plaintext, mode, ctx.getCek, {
      contentHash: rec.contentHash,
      workspaceId: rec.workspaceId,
    })
    await ctx.blobStore.put(rec.workspaceId, rec.contentKey, sealed)
    await ctx.store.delete(userId, rec.assetBlockId)
    return 'uploaded'
  } catch (err) {
    if (err instanceof BlobPutError && err.permanent) {
      await ctx.store.markFailed(userId, rec.assetBlockId)
      return 'failed'
    }
    // Transient upload error, an encode error, or a non-enumerated permanent —
    // all bounded so none can hot-loop.
    return retryOrFail(userId, rec, ctx)
  }
}

/** Drain every `pending` byte record for `userId`. Sequential — the queue is
 *  small and this avoids hammering Storage; the caller runs it single-owner. */
export const drainUploads = async (userId: string, deps: UploadDrainDeps): Promise<DrainSummary> => {
  const ctx: DrainOneCtx = {
    store: deps.store,
    byteStore: deps.byteStore,
    blobStore: deps.blobStore,
    getMaterializability: deps.getMaterializability,
    getCek: deps.getCek,
    now: deps.now ?? (() => Date.now()),
    maxAttempts: deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    maxAgeMs: deps.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
  }

  const pending = await deps.store.listByStatus(userId, 'pending')
  const tally: Record<DrainOutcome, number> = { uploaded: 0, failed: 0, deferred: 0, retried: 0 }
  for (const rec of pending) {
    tally[await drainOne(userId, rec, ctx)] += 1
  }
  return tally
}
