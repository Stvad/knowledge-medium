/**
 * The asset content hash (§5.1 / §10): sha256 of the PLAINTEXT bytes, the
 * value stored in `block.properties.hash` and the read-side integrity gate.
 *
 * The read path (§7.3 resolver) verifies decrypted/served bytes against this
 * hash before caching or rendering them, and rejects on mismatch — the
 * load-bearing defense against an untrusted server returning arbitrary or
 * stale bytes for a content path (the AAD binding is redundant-but-cheap
 * defense-in-depth, §5.1). The same raw digest seeds the content-addressed
 * Storage path (§10): a plaintext workspace uses it directly, an E2EE
 * workspace wraps it as HMAC(K_id, …).
 */

import { bytesToHex } from './hex.js'

/** Prefix tag on the stored hash string — `sha256:<lowercase-hex>`. */
export const CONTENT_HASH_PREFIX = 'sha256:'

/** Raw sha256 digest of the plaintext bytes (32 bytes). The content-key
 *  derivation (§10) consumes this digest; {@link computeContentHash} formats
 *  the `block.properties.hash` string from it. */
export const sha256 = async (bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))

/** Format plaintext bytes as the `sha256:<hex>` content-hash string. */
export const computeContentHash = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
  CONTENT_HASH_PREFIX + bytesToHex(await sha256(bytes))

/** Read-side integrity gate (§5.1): do these bytes hash to `expected`? The
 *  hash is not a secret (the server already knows the plaintext sha256 for a
 *  plaintext workspace), so a plain string compare is sufficient. */
export const verifyContentHash = async (
  bytes: Uint8Array<ArrayBuffer>,
  expected: string,
): Promise<boolean> =>
  (await computeContentHash(bytes)) === expected
