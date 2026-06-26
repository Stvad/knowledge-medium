/**
 * The `encb:v1:` BINARY ciphertext envelope (§5.1) — the byte-lane sibling
 * of the text path's `enc:v1:` envelope (envelope.ts).
 *
 *   "encb:v1:" (raw 8-byte magic) ‖ nonce(12) ‖ ciphertext‖tag
 *
 * Unlike enc:v1:, this is RAW BYTES, not base64url text: asset bytes are
 * already binary, so base64-framing them would cost ≈33% for nothing, and the
 * text seal/open seam is string→string over TextEncoder/TextDecoder, which
 * would corrupt non-UTF-8 bytes (invalid sequences are replaced). The nonce/
 * tag layout and schema version (`v1`) are shared with the text path so the
 * AAD machinery is identical.
 *
 * Like enc:v1:, the magic is a FORMAT tag, not a decrypt trigger — only the
 * durable mode pin decides whether bytes should be decrypted (§5.1 / §7).
 */

import { GCM_TAG_BYTES, NONCE_BYTES } from './envelope.js'

const utf8Encode = new TextEncoder()

/** Raw-byte magic for the binary envelope (the 8 ASCII bytes of `encb:v1:`).
 *  The byte-lane analog of ENVELOPE_PREFIX. */
export const BINARY_ENVELOPE_MAGIC = utf8Encode.encode('encb:v1:')
export const BINARY_MAGIC_BYTES = BINARY_ENVELOPE_MAGIC.length

/** Bytes the envelope adds on top of the plaintext: magic ‖ nonce ‖ GCM tag (the
 *  ciphertext is otherwise the plaintext's own length, so for a payload of L bytes
 *  the sealed object is `L + BINARY_ENVELOPE_OVERHEAD_BYTES`). The up-lane sizes
 *  the e2ee capture guard by this so a sealed object can't exceed the bucket's
 *  file_size_limit — a passthrough (plaintext) object adds nothing. */
export const BINARY_ENVELOPE_OVERHEAD_BYTES = BINARY_MAGIC_BYTES + NONCE_BYTES + GCM_TAG_BYTES

/** Smallest possible valid envelope: magic ‖ nonce ‖ (empty ciphertext) ‖ tag —
 *  identical to the overhead (empty payload). A blob carrying the magic but
 *  shorter than this CANNOT be a real envelope (it can't hold a nonce + auth tag)
 *  — it's a truncated/forged object. The off-path audit uses this as a length
 *  floor so an `encb:v1:`-prefixed runt can't pass the cheap magic check. Mirrors
 *  `decodeBinaryEnvelope`'s payload guard (`payload.length >= NONCE_BYTES + GCM_TAG_BYTES`). */
export const BINARY_ENVELOPE_MIN_BYTES = BINARY_ENVELOPE_OVERHEAD_BYTES

export interface DecodedBinaryEnvelope {
  // ArrayBuffer-backed (via .slice()) so they flow into WebCrypto's
  // BufferSource params without a cast.
  readonly nonce: Uint8Array<ArrayBuffer>
  readonly ciphertext: Uint8Array<ArrayBuffer>
}

/** Cheap magic check. Says nothing about whether the payload decodes —
 *  use {@link decodeBinaryEnvelope} (or the AEAD verify) for that. */
export const hasBinaryEnvelopeMagic = (blob: Uint8Array): boolean => {
  if (blob.length < BINARY_MAGIC_BYTES) return false
  for (let i = 0; i < BINARY_MAGIC_BYTES; i++) {
    if (blob[i] !== BINARY_ENVELOPE_MAGIC[i]) return false
  }
  return true
}

export const encodeBinaryEnvelope = (
  nonce: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array<ArrayBuffer> => {
  if (nonce.length !== NONCE_BYTES) {
    throw new Error(`binary envelope: nonce must be ${NONCE_BYTES} bytes, got ${nonce.length}`)
  }
  const out = new Uint8Array(BINARY_MAGIC_BYTES + nonce.length + ciphertext.length)
  out.set(BINARY_ENVELOPE_MAGIC, 0)
  out.set(nonce, BINARY_MAGIC_BYTES)
  out.set(ciphertext, BINARY_MAGIC_BYTES + nonce.length)
  return out
}

export const decodeBinaryEnvelope = (blob: Uint8Array): DecodedBinaryEnvelope => {
  if (!hasBinaryEnvelopeMagic(blob)) {
    throw new Error('binary envelope: missing encb:v1: magic')
  }
  const payload = blob.subarray(BINARY_MAGIC_BYTES)
  if (payload.length < NONCE_BYTES + GCM_TAG_BYTES) {
    throw new Error('binary envelope: payload too short to hold a nonce and auth tag')
  }
  // .slice() (not .subarray()) returns fresh ArrayBuffer-backed copies, so the
  // views are Uint8Array<ArrayBuffer> and safe to hand to WebCrypto.
  return {
    nonce: payload.slice(0, NONCE_BYTES),
    ciphertext: payload.slice(NONCE_BYTES),
  }
}
