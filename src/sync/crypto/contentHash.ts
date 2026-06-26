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

import { bytesToHex, hexToBytes } from './hex.js'

/** Prefix tag on the stored hash string — `sha256:<lowercase-hex>`. */
export const CONTENT_HASH_PREFIX = 'sha256:'

/** Raw sha256 digest length in bytes (sha256 = 256 bits). */
const SHA256_BYTES = 32

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

/** Recover the raw 32-byte sha256 digest from a stored `sha256:<hex>` content
 *  hash — the inverse of {@link computeContentHash}. The content-key derivation
 *  (§10) consumes this digest (raw for a plaintext workspace, HMAC'd for E2EE).
 *  Strict: a missing/wrong prefix or a non-32-byte body throws, so a malformed
 *  `block.properties.hash` fails closed at the resolver instead of routing to a
 *  bogus Storage path. */
export const digestFromContentHash = (contentHash: string): Uint8Array<ArrayBuffer> => {
  if (!contentHash.startsWith(CONTENT_HASH_PREFIX)) {
    throw new Error(`content hash: missing '${CONTENT_HASH_PREFIX}' prefix`)
  }
  const digest = hexToBytes(contentHash.slice(CONTENT_HASH_PREFIX.length))
  if (digest.length !== SHA256_BYTES) {
    throw new Error(`content hash: expected ${SHA256_BYTES}-byte digest, got ${digest.length}`)
  }
  return digest
}
