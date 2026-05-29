/**
 * The `enc:v1:` ciphertext envelope (§6 "Ciphertext format").
 *
 *   "enc:v1:" + base64url(nonce ‖ ciphertext)
 *
 * The envelope carries ONLY nonce ‖ ciphertext — no separate version
 * field — so a decryptor reconstructs the AAD's `schema_version` from
 * the `v1` tag alone (§6). `ciphertext` here is WebCrypto's AES-GCM
 * output, i.e. ciphertext bytes with the 16-byte auth tag appended.
 *
 * The prefix is a FORMAT tag and sanity check, NOT a decrypt trigger:
 * per §6 only the durable local mode pin decides whether a value should
 * be decrypted. A plaintext-workspace value that happens to start with
 * `enc:v1:` is left untouched by the seam.
 */

import { bytesToBase64Url, base64UrlToBytes } from './base64url.js'

export const ENVELOPE_PREFIX = 'enc:v1:'
/** The `v1` of the envelope — this IS the AAD's schema_version (§6). */
export const SCHEMA_VERSION = 1
/** AES-GCM nonce length in bytes (96-bit, §6). */
export const NONCE_BYTES = 12
/** AES-GCM auth tag length in bytes. */
export const GCM_TAG_BYTES = 16

export interface DecodedEnvelope {
  // ArrayBuffer-backed (via .slice()) so they flow into WebCrypto's
  // BufferSource params without a cast.
  readonly nonce: Uint8Array<ArrayBuffer>
  readonly ciphertext: Uint8Array<ArrayBuffer>
}

/** Cheap prefix check. Says nothing about whether the payload decodes —
 *  use {@link decodeEnvelope} (or the AEAD verify) for that. */
export const hasEnvelopePrefix = (value: string): boolean =>
  value.startsWith(ENVELOPE_PREFIX)

export const encodeEnvelope = (nonce: Uint8Array, ciphertext: Uint8Array): string => {
  if (nonce.length !== NONCE_BYTES) {
    throw new Error(`envelope: nonce must be ${NONCE_BYTES} bytes, got ${nonce.length}`)
  }
  const payload = new Uint8Array(nonce.length + ciphertext.length)
  payload.set(nonce, 0)
  payload.set(ciphertext, nonce.length)
  return ENVELOPE_PREFIX + bytesToBase64Url(payload)
}

export const decodeEnvelope = (value: string): DecodedEnvelope => {
  if (!hasEnvelopePrefix(value)) {
    throw new Error('envelope: missing enc:v1: prefix')
  }
  const payload = base64UrlToBytes(value.slice(ENVELOPE_PREFIX.length))
  if (payload.length < NONCE_BYTES + GCM_TAG_BYTES) {
    throw new Error('envelope: payload too short to hold a nonce and auth tag')
  }
  // .slice() (not .subarray()) returns fresh ArrayBuffer-backed copies, so
  // the views are Uint8Array<ArrayBuffer> and safe to hand to WebCrypto.
  return {
    nonce: payload.slice(0, NONCE_BYTES),
    ciphertext: payload.slice(NONCE_BYTES),
  }
}
