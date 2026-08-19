/**
 * The in-thread asset resolver (design §7.3) — the single place that turns a
 * media block's `(workspaceId, contentHash)` into displayable plaintext bytes,
 * or a fail-closed verdict.
 *
 * Flow on a local miss (§7.3 / §8 / §10):
 *   materializability → derive content-key → fetch ciphertext → decode
 *   (decrypt with the WK / passthrough plaintext) → HASH-VERIFY → store → bytes
 *
 * THE HASH VERIFY IS THE LOAD-BEARING CONTROL. After the §10.1 reversal (no
 * server-side write guard), this read-side check against the block's synced
 * `hash` is the SOLE byte-confidentiality / integrity gate: the untrusted server
 * (e2ee §2) may return arbitrary or stale bytes for a content path, and the AAD
 * tag alone can't catch a poisoner who knows the content hash and seals junk
 * under the right AAD. So anything that isn't the genuine plaintext — a fetch
 * failure, an AEAD-open failure, OR a hash mismatch — is discarded, NEVER stored
 * and NEVER served; the caller renders the broken-asset placeholder. This is the
 * hard Phase-3 acceptance gate (§17), not an optimization.
 *
 * Three-valued, never two-valued (§5.1 / §7.3 / e2ee §6 rule 2): the decode
 * decision is driven by `getMaterializability` — decrypt (e2ee + WK) / copy
 * (plaintext-pinned) / defer (e2ee without WK, unpinned, or signed out). `defer`
 * fails CLOSED (no fetch, no passthrough) — never `getMode`'s two-valued
 * downgrade, which would serve attacker plaintext for an evicted-pin workspace.
 *
 * Returns verified BYTES, not an object URL: the renderer (Phase 4) wraps them
 * as `Blob([bytes], { type: mime })` → `createObjectURL` (mime is block
 * metadata) and owns the revoke-on-unmount lifecycle. Keeping the resolver at
 * bytes makes the security-critical core fully unit-testable without the DOM.
 */

import { decodeBytes } from '@/sync/byteTransform.js'
import { deriveContentKey } from '@/sync/crypto/contentKey.js'
import { verifyContentHash } from '@/sync/crypto/contentHash.js'
import {
  materializabilityToMode,
  type GetCek,
  type GetMaterializability,
  type SyncMode,
} from '@/sync/transform.js'
import type { BlobStore } from './blobStore.js'
import type { ByteStore } from './byteStore.js'

/** What the renderer asks the resolver to materialize. */
export interface AssetResolveRequest {
  readonly workspaceId: string
  /** The block's synced `sha256:<hex>` content hash (§5.1). */
  readonly contentHash: string
}

/** Why a resolve failed closed — every value renders the broken-asset
 *  placeholder; none ever serves bytes. Distinguished for diagnostics + so the
 *  caller can word the placeholder (e.g. `no-content-key` → "re-paste the key";
 *  `fetch-failed` while offline → "not downloaded yet"). */
export type AssetFailReason =
  /** Locked / unpinned / signed out (`defer`) — never passthrough. */
  | 'deferred'
  /** E2EE workspace with no K_id on this device (the §10 re-paste migration). */
  | 'no-content-key'
  /** Malformed `contentHash` — can't derive a path. */
  | 'invalid-hash'
  /** The object is absent / RLS-denied / a network error (offline → transient). */
  | 'fetch-failed'
  /** AEAD open failed: wrong key, tampered envelope, or mismatched AAD (§5.1). */
  | 'decode-failed'
  /** Decoded bytes don't match the block's `hash` — an untrusted-server replay
   *  or poison (§5.1). The discarded-and-never-served case. */
  | 'hash-mismatch'
  /** BACKLOG-LANE ONLY: bytes were fetched + verified but the local byte-store
   *  WRITE failed (quota / OPFS), so no durable copy exists. The demand lane never
   *  returns this — it serves the verified bytes uncached (step 7); only `replicate`
   *  cares that the copy didn't land, so it must NOT report `replicated`. Treated as
   *  storage-WIDE (the down-lane stops the pass — see downLane.ts). */
  | 'store-failed'
  /** An unexpected internal error (a misbehaving injected policy dep, an OPFS
   *  error outside the guarded reads). The fail-closed safety net — `resolve`
   *  returns a verdict, never a thrown promise (§7.3). */
  | 'error'

export type AssetResolveResult =
  | { readonly ok: true; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly ok: false; readonly reason: AssetFailReason }

/** The fail-closed reasons that arise BEFORE any network fetch (the `prepare` stage:
 *  signed-out, locked, missing K_id, malformed hash) — as opposed to the fetch-stage
 *  reasons (`fetch-failed` / `decode-failed` / `hash-mismatch`, and `error`) that can
 *  only arise after hitting the network. The down-lane uses this split purely for its
 *  summary tally: pre-fetch failures are reported `unavailable` (no point retrying
 *  without a key / unlock), fetch-stage ones `failed` (transient, retried next pass).
 *  Neither consumes the down-lane budget — only a successful download does (see
 *  downLane.ts), so a stable-ordered failing prefix never starves the healthy tail. */
export const PRE_FETCH_FAIL_REASONS: ReadonlySet<AssetFailReason> = new Set([
  'deferred',
  'no-content-key',
  'invalid-hash',
])

/** The down-lane backlog outcome (§8/§9): the asset's verified plaintext is now in
 *  the local byte store. `present` = already there (a cheap has() probe, no fetch);
 *  `replicated` = freshly fetched + verified + stored. A failure carries the same
 *  fail-closed reason as a resolve — `fetch-failed` is transient (retried next pass),
 *  the rest are the §7.3/§5.1 closed verdicts. Reports a STATUS, never bytes: the
 *  down-lane needs presence, not pixels. */
export type AssetReplicateResult =
  | { readonly ok: true; readonly status: 'present' | 'replicated' }
  | { readonly ok: false; readonly reason: AssetFailReason }

export interface AssetResolverDeps {
  /** The active account — the byte store's account-isolation scope (§7). A
   *  signed-out resolver fails closed (`deferred`). */
  readonly getUserId: () => string | null
  readonly byteStore: ByteStore
  readonly blobStore: BlobStore
  /** The three-valued decode decision (§7.3). */
  readonly getMaterializability: GetMaterializability
  /** The workspace key for AEAD-open (e2ee only). */
  readonly getCek: GetCek
  /** The workspace's content-key HMAC subkey K_id (§10); null on a legacy
   *  device → e2ee fails closed (`no-content-key`). */
  readonly getContentKeyHmac: (workspaceId: string) => Promise<CryptoKey | null>
}

export interface AssetResolver {
  resolve(request: AssetResolveRequest): Promise<AssetResolveResult>
  /** The §8/§9 background backlog lane: ensure the asset's verified plaintext is in
   *  the local byte store. CHEAP when already present (an in-memory check against
   *  `present` if given, else a `has()` probe — no byte read, no remote egress); on a
   *  miss it runs the SAME coalesced fetch primitive `resolve` uses (so a backlog item
   *  and a concurrent demand render share one download, §8) and discards the bytes.
   *  `present` is an optional one-shot enumeration of the workspace's stored content-keys
   *  (see {@link ByteStore.listWorkspaceKeys}) so a whole down-lane pass costs ONE dir
   *  scan instead of a has() per block. Never throws — fails closed to a verdict. */
  replicate(request: AssetResolveRequest, present?: ReadonlySet<string>): Promise<AssetReplicateResult>
}

/** The shared fail-closed verdict. Typed as just the failure shape (not the whole
 *  `AssetResolveResult` union) so it's assignable to every result type that carries it
 *  — `AssetResolveResult`, the internal `ResolveOutcome`, and `AssetReplicateResult`. */
const fail = (reason: AssetFailReason): { readonly ok: false; readonly reason: AssetFailReason } => ({
  ok: false,
  reason,
})

/** The fail-closed verdict or the derived identity shared by `resolve` (demand) and
 *  `replicate` (backlog) — steps (1)+(2) of the §7.3 flow: signed-in, three-valued
 *  decode mode, and the §10 content-key that addresses both the local store and the
 *  remote object. Returning the derivation (not just running it twice) lets the
 *  backlog lane probe `has()` with the same key the demand lane fetches under. */
type PreparedResolve =
  | { readonly ok: true; readonly userId: string; readonly mode: SyncMode; readonly contentKey: string }
  | { readonly ok: false; readonly reason: AssetFailReason }

/** Where the verified bytes came from this resolve — the backlog-only provenance the
 *  public {@link AssetResolveResult} hides. The demand lane drops it (a render is served
 *  from `bytes` regardless); the backlog lane maps it to a replicate status so it never
 *  mistakes a hit for a download:
 *    - `local`      — already in the byte store (a hit, step 3) → `present` (free).
 *    - `downloaded` — freshly fetched + verified + STORED (step 7) → `replicated`.
 *    - `unstored`   — freshly fetched + verified but the store write FAILED (quota /
 *                     OPFS) → `store-failed`.
 *  Read directly from the outcome, NOT a second `has()` probe (which a flaky store would
 *  make unreliable) — and crucially distinct from a local hit, so a hit reached via a
 *  flaky `has()` fallthrough isn't charged against the down-lane budget as a download. */
type ResolveSource = 'local' | 'downloaded' | 'unstored'
type ResolveOutcome =
  | { readonly ok: true; readonly bytes: Uint8Array<ArrayBuffer>; readonly source: ResolveSource }
  | { readonly ok: false; readonly reason: AssetFailReason }

export const createAssetResolver = (deps: AssetResolverDeps): AssetResolver => {
  const { getUserId, byteStore, blobStore, getMaterializability, getCek, getContentKeyHmac } = deps
  // Coalesce concurrent identical resolves (see `coalescedResolve` below).
  const inFlight = new Map<string, Promise<ResolveOutcome>>()

  /** Steps (1)+(2): signed-in check, three-valued decode decision (§7.3), and the
   *  §10 content-key. Any rejection bubbles to the caller's outer safety net (→
   *  `error`). Shared by both lanes so the backlog `has()` probe and the demand fetch
   *  address the byte store with the same key. */
  const prepare = async ({ workspaceId, contentHash }: AssetResolveRequest): Promise<PreparedResolve> => {
    const userId = getUserId()
    if (!userId) return { ok: false, reason: 'deferred' } // signed out — can't scope the store

    // (1) Three-valued decode decision — `defer` fails CLOSED before any fetch. An
    // UNEXPECTED value (a buggy / hostile policy provider) also fails closed: it must
    // NOT fall through to plaintext passthrough — that default is exactly the
    // two-valued downgrade this resolver exists to avoid.
    const materializability = await getMaterializability(workspaceId)
    const mode = materializabilityToMode(materializability)
    if (mode === null) {
      if (materializability === 'defer') return { ok: false, reason: 'deferred' }
      console.warn(
        `[assetResolver] unexpected materializability "${materializability}" for ${workspaceId}; failing closed`,
      )
      return { ok: false, reason: 'error' }
    }

    // (2) The content-key (§10) addresses both the local store and the remote object.
    // E2EE needs K_id; its absence (legacy device) fails closed — and since K_id
    // co-lives with the WK, an unlocked e2ee workspace that stored bytes always has
    // it, so this never strands already-stored bytes.
    const contentKeyHmac = mode === 'e2ee' ? await getContentKeyHmac(workspaceId) : null
    if (mode === 'e2ee' && !contentKeyHmac) return { ok: false, reason: 'no-content-key' }
    try {
      return { ok: true, userId, mode, contentKey: await deriveContentKey({ contentHash, mode, contentKeyHmac }) }
    } catch {
      return { ok: false, reason: 'invalid-hash' }
    }
  }

  const resolveImpl = async ({ workspaceId, contentHash }: AssetResolveRequest): Promise<ResolveOutcome> => {
    // Outer safety net: ANY unexpected throw (a misbehaving injected policy dep, an
    // OPFS error the inner guards don't anticipate) returns a verdict, never a thrown
    // promise — the renderer always gets a placeholder, never an unhandled rejection
    // (the §7.3 fail-closed contract). The inner per-stage catches still run first, so
    // a throw only reaches here if it's genuinely unanticipated.
    try {
      const prep = await prepare({ workspaceId, contentHash })
      if (!prep.ok) return fail(prep.reason)
      const { userId, mode, contentKey } = prep

      // (3) Local hit — already verified when stored (§8), serve directly. A
      // transient store-read error is treated as a MISS (the bytes are re-fetchable,
      // §8), not a hard failure: fall through to the network.
      let local: Uint8Array<ArrayBuffer> | null = null
      try {
        local = await byteStore.get(userId, workspaceId, contentKey)
      } catch (err) {
        console.warn(`[assetResolver] local byte-store read failed for ${workspaceId}; re-fetching`, err)
      }
      if (local) return { ok: true, bytes: local, source: 'local' } // already durable (§8) — a hit, not a download

      // (4) Miss → fetch the ciphertext (direct RLS-gated GET, §10.1).
      let blob: Uint8Array<ArrayBuffer>
      try {
        blob = await blobStore.get(workspaceId, contentKey)
      } catch {
        return fail('fetch-failed') // absent / denied / offline — transient or §9 backstop
      }

      // (5) Decode: identity for plaintext, AEAD-open for e2ee (throws on a wrong
      // key / tampered envelope / mismatched AAD).
      let plaintext: Uint8Array<ArrayBuffer>
      try {
        plaintext = await decodeBytes(blob, mode, getCek, { contentHash, workspaceId })
      } catch {
        return fail('decode-failed')
      }

      // (6) THE load-bearing check (§5.1). A mismatch is discarded — never stored,
      // never served — even though step 5's AEAD tag passed.
      if (!(await verifyContentHash(plaintext, contentHash))) return fail('hash-mismatch')

      // (7) Cache the verified bytes, then serve. A cache-write failure (quota) must
      // NOT deny the render — serve these verified bytes; the next render re-fetches.
      // `source` records whether the copy actually landed: the demand lane ignores it
      // (serves either way), the backlog lane needs it to not claim a phantom replication.
      let stored = false
      try {
        await byteStore.put(userId, workspaceId, contentKey, plaintext)
        stored = true
      } catch (err) {
        console.warn(`[assetResolver] byte-store write failed for ${workspaceId}; serving uncached`, err)
      }
      return { ok: true, bytes: plaintext, source: stored ? 'downloaded' : 'unstored' }
    } catch (err) {
      console.warn(`[assetResolver] unexpected error resolving ${workspaceId}; failing closed`, err)
      return fail('error')
    }
  }

  const coalescedResolve = (request: AssetResolveRequest): Promise<ResolveOutcome> => {
    // Coalesce CONCURRENT resolves of the same (user, workspace, contentHash): the same
    // asset embedded N times mounts N components that each resolve in the same tick;
    // share ONE OPFS-read + decrypt + verify instead of N. NOT a persistent cache —
    // the entry is dropped the moment the resolve settles, so verified plaintext is
    // never retained past the in-flight window (each consumer wraps the shared bytes
    // in its own Blob). `resolveImpl` never throws (it fails closed to a verdict), so
    // one shared promise is safe to hand to every concurrent caller — including the
    // backlog `replicate` lane, so a demand render and a backlog fetch of the same
    // asset ride ONE download (§8).
    //
    // The key INCLUDES the active user (read synchronously, so the get→set below stays
    // atomic and same-epoch callers still coalesce): the demand + backlog lanes share
    // this map, so a background `replicate()` fetched under account A must NEVER be handed
    // to a `resolve()` that runs after an account switch to B — B would skip its own
    // `prepare()` + byte-store scope and receive A's plaintext. Different principal →
    // different key → its own fetch. (Same-user key-state changes — lock / rotate — need
    // no epoch in the key: the bytes are content-addressed + hash-verified, so identical
    // regardless of key epoch, and lock doesn't scrub already-authorized in-flight work
    // any more than it scrubs the stored byte / `blocks` table. Keying by the post-prepare
    // `contentKey` would instead force an `await prepare()` before this dedup, reopening a
    // get→set race that double-fetches.)
    const key = `${getUserId() ?? ''}\n${request.workspaceId}\n${request.contentHash}`
    const existing = inFlight.get(key)
    if (existing) return existing
    const pending = resolveImpl(request).finally(() => inFlight.delete(key))
    inFlight.set(key, pending)
    return pending
  }

  // The public demand lane: just the verdict + bytes. The internal `stored` bit is for
  // the backlog lane only, so it's dropped here (callers render from `bytes` regardless).
  const resolve = async (request: AssetResolveRequest): Promise<AssetResolveResult> => {
    const r = await coalescedResolve(request)
    return r.ok ? { ok: true, bytes: r.bytes } : r
  }

  const replicate = async (
    request: AssetResolveRequest,
    present?: ReadonlySet<string>,
  ): Promise<AssetReplicateResult> => {
    try {
      // Same (1)+(2) the demand lane runs — fail-closed reasons pass straight through
      // (a locked / signed-out / legacy workspace can't replicate, exactly as it can't
      // render), without ever touching the network.
      const prep = await prepare(request)
      if (!prep.ok) return { ok: false, reason: prep.reason }

      // CHEAP presence check — no byte read, no fetch. The down-lane walks every media
      // block, so the steady state (already replicated) must cost ~nothing per block.
      // `present` is a one-shot enumeration of the workspace's stored content-keys the
      // caller (the down-lane) passes so the WHOLE pass is one dir scan, not a has() per
      // block; absent the hint, probe has() directly. A transient has() error is treated
      // as UNKNOWN (not a failure): fall through to the coalesced fetch, which re-checks
      // local via get() anyway. (A `present` snapshot-miss that's actually present — stored
      // mid-pass by a concurrent demand resolve — also falls through and is caught by that
      // get() local hit, so the hint can only ever cost a redundant get(), never a leak.)
      let isPresent = false
      if (present) {
        isPresent = present.has(prep.contentKey)
      } else {
        try {
          isPresent = await byteStore.has(prep.userId, request.workspaceId, prep.contentKey)
        } catch (err) {
          console.warn(`[assetResolver] has() probe failed for ${request.workspaceId}; fetching`, err)
        }
      }
      if (isPresent) return { ok: true, status: 'present' }

      // Miss → run the SAME coalesced fetch primitive the demand lane uses (a demand
      // render and a backlog fetch of the same asset ride ONE download, §8), discarding
      // the bytes — we only need them durable in the store. It re-derives via prepare(),
      // cheap next to the network fetch.
      const r = await coalescedResolve(request)
      if (!r.ok) return { ok: false, reason: r.reason }

      // Map the resolve's provenance to a replicate status — NOT just `ok`, which a
      // resolve also returns for a LOCAL HIT and for a fetch whose store WRITE failed
      // (quota; it serves the demand render uncached, step 7). The down-lane charges only
      // `replicated` against its budget, so we must report:
      //   - `present` for a `local` hit — including one reached because the has() probe
      //     above threw (transient) and we fell through to a get()-served hit. Charging
      //     it would let a flaky-has() prefix of present assets burn the budget every
      //     sweep and skip the absent tail.
      //   - `store-failed` for an `unstored` fetch — nothing durable landed, so claiming
      //     `replicated` would spend the budget while the asset stays absent + re-downloads
      //     (full egress) every sweep.
      if (r.source === 'unstored') return { ok: false, reason: 'store-failed' }
      return { ok: true, status: r.source === 'local' ? 'present' : 'replicated' }
    } catch (err) {
      console.warn(`[assetResolver] unexpected error replicating ${request.workspaceId}; failing closed`, err)
      return { ok: false, reason: 'error' }
    }
  }

  return { resolve, replicate }
}
