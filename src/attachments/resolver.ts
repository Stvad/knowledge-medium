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

import { decodeBytes } from '../sync/byteTransform.js'
import { deriveContentKey } from '../sync/crypto/contentKey.js'
import { verifyContentHash } from '../sync/crypto/contentHash.js'
import { materializabilityToMode, type GetCek, type GetMaterializability } from '../sync/transform.js'
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
  /** An unexpected internal error (a misbehaving injected policy dep, an OPFS
   *  error outside the guarded reads). The fail-closed safety net — `resolve`
   *  returns a verdict, never a thrown promise (§7.3). */
  | 'error'

export type AssetResolveResult =
  | { readonly ok: true; readonly bytes: Uint8Array<ArrayBuffer> }
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
}

const fail = (reason: AssetFailReason): AssetResolveResult => ({ ok: false, reason })

export const createAssetResolver = (deps: AssetResolverDeps): AssetResolver => {
  const { getUserId, byteStore, blobStore, getMaterializability, getCek, getContentKeyHmac } = deps

  return {
    async resolve({ workspaceId, contentHash }): Promise<AssetResolveResult> {
      // Outer safety net: ANY unexpected throw (a misbehaving injected policy
      // dep, an OPFS error the inner guards don't anticipate) returns a verdict,
      // never a thrown promise — the renderer always gets a placeholder, never an
      // unhandled rejection (the §7.3 fail-closed contract). The inner per-stage
      // catches still run first, so a throw only reaches here if it's genuinely
      // unanticipated.
      try {
        const userId = getUserId()
        if (!userId) return fail('deferred') // signed out — can't scope the store

        // (1) Three-valued decode decision (§7.3) — defer fails CLOSED before any
        // fetch. An UNEXPECTED value (a buggy / hostile policy provider) also fails
        // closed: it must NOT fall through to plaintext passthrough — that default
        // is exactly the two-valued downgrade this resolver exists to avoid.
        const materializability = await getMaterializability(workspaceId)
        const mode = materializabilityToMode(materializability)
        if (mode === null) {
          // `defer` fails closed (no fetch, no passthrough). Any OTHER null — an
          // unexpected value from a buggy/hostile provider — must ALSO fail closed,
          // loudly: never fall through to plaintext (the two-valued downgrade this
          // resolver exists to avoid).
          if (materializability === 'defer') return fail('deferred')
          console.warn(
            `[assetResolver] unexpected materializability "${materializability}" for ${workspaceId}; failing closed`,
          )
          return fail('error')
        }

        // (2) The content-key (§10) addresses both the local store and the remote
        // object. E2EE needs K_id; its absence (legacy device) fails closed — and
        // since K_id co-lives with the WK, an unlocked e2ee workspace that stored
        // bytes always has it, so this never strands already-stored bytes.
        const contentKeyHmac = mode === 'e2ee' ? await getContentKeyHmac(workspaceId) : null
        if (mode === 'e2ee' && !contentKeyHmac) return fail('no-content-key')
        let contentKey: string
        try {
          contentKey = await deriveContentKey({ contentHash, mode, contentKeyHmac })
        } catch {
          return fail('invalid-hash')
        }

        // (3) Local hit — already verified when stored (§8), serve directly. A
        // transient store-read error is treated as a MISS (the bytes are
        // re-fetchable, §8), not a hard failure: fall through to the network.
        let local: Uint8Array<ArrayBuffer> | null = null
        try {
          local = await byteStore.get(userId, workspaceId, contentKey)
        } catch (err) {
          console.warn(`[assetResolver] local byte-store read failed for ${workspaceId}; re-fetching`, err)
        }
        if (local) return { ok: true, bytes: local }

        // (4) Miss → fetch the ciphertext (direct RLS-gated GET, §10.1).
        let blob: Uint8Array<ArrayBuffer>
        try {
          blob = await blobStore.get(workspaceId, contentKey)
        } catch {
          return fail('fetch-failed') // absent / denied / offline — transient or §9 backstop
        }

        // (5) Decode: identity for plaintext, AEAD-open for e2ee (throws on a
        // wrong key / tampered envelope / mismatched AAD).
        let plaintext: Uint8Array<ArrayBuffer>
        try {
          plaintext = await decodeBytes(blob, mode, getCek, { contentHash, workspaceId })
        } catch {
          return fail('decode-failed')
        }

        // (6) THE load-bearing check (§5.1). A mismatch is discarded — never
        // stored, never served — even though step 5's AEAD tag passed.
        if (!(await verifyContentHash(plaintext, contentHash))) return fail('hash-mismatch')

        // (7) Cache the verified bytes, then serve. A cache-write failure (quota)
        // must NOT deny the render — serve these verified bytes; the next render
        // re-fetches.
        try {
          await byteStore.put(userId, workspaceId, contentKey, plaintext)
        } catch (err) {
          console.warn(`[assetResolver] byte-store write failed for ${workspaceId}; serving uncached`, err)
        }
        return { ok: true, bytes: plaintext }
      } catch (err) {
        console.warn(`[assetResolver] unexpected error resolving ${workspaceId}; failing closed`, err)
        return fail('error')
      }
    },
  }
}
