/**
 * AES-256-GCM seal/open over the `encb:v1:` BINARY envelope (§5.1) — the
 * byte-lane analog of aead.ts. Operates on raw `Uint8Array` plaintext (asset
 * bytes), not strings.
 *
 * One object-write = one seal with a fresh 96-bit random nonce. The AAD
 * (assetBytesAad in ./aad.ts) binds the ciphertext to its
 * (content_hash, workspace, "asset-bytes", schema_version); `open`
 * reconstructs the same AAD and lets the GCM tag authenticate it — a swapped
 * or tampered object fails to decrypt.
 *
 * This authenticates the envelope only. It does NOT prove the bytes MATCH the
 * content key (the seam has no key beyond the WK) — a poisoner who knows the
 * content hash can seal arbitrary bytes under the right AAD. The load-bearing
 * defense is the read-side sha256 check against `block.properties.hash`
 * (contentHash.ts / §5.1), which the resolver runs before caching/serving.
 *
 * Keys are WebCrypto `CryptoKey` handles (non-extractable in production, §5);
 * this module never sees raw key bytes.
 */

import { decodeBinaryEnvelope, encodeBinaryEnvelope } from './binaryEnvelope.js'
import { NONCE_BYTES } from './envelope.js'

/** Seal raw bytes into an `encb:v1:` binary envelope under `key` + `aad`. */
export const sealBytes = async (
  key: CryptoKey,
  plaintext: Uint8Array<ArrayBuffer>,
  aad: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> => {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, plaintext),
  )
  return encodeBinaryEnvelope(nonce, ciphertext)
}

/** Open an `encb:v1:` binary envelope, returning the raw plaintext bytes.
 *  Throws on AEAD failure (wrong key, tampered ciphertext, or mismatched
 *  AAD). */
export const openBytes = async (
  key: CryptoKey,
  envelope: Uint8Array,
  aad: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> => {
  const { nonce, ciphertext } = decodeBinaryEnvelope(envelope)
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, ciphertext),
  )
}
