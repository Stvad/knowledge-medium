/**
 * AES-256-GCM seal/open over the `enc:v1:` envelope (§6).
 *
 * One column-write = one `seal` with a fresh 96-bit random nonce. The
 * AAD (./aad.ts) binds the ciphertext to its block/workspace/column/
 * schema-version. `open` reconstructs the same AAD and lets the GCM tag
 * authenticate it — a swapped or tampered ciphertext fails to decrypt.
 *
 * Keys are WebCrypto `CryptoKey` handles (non-extractable in production,
 * §5); this module never sees raw key bytes.
 */

import { decodeEnvelope, encodeEnvelope, NONCE_BYTES } from './envelope.js'

const utf8Encode = new TextEncoder()
// `ignoreBOM: true` is REQUIRED for the round-trip, not a tuning knob: the
// default decoder treats a leading U+FEFF as a byte-order mark and silently
// eats it, so `open(seal(x))` returned `x` minus its first character for any
// plaintext starting with a zero-width no-break space (found by
// aead.fuzz.test.ts, issue #534). `seal` never writes a BOM of its own —
// `TextEncoder` emits the code point verbatim — so every U+FEFF in the
// decrypted bytes is real content and must survive the decode.
const utf8Decode = new TextDecoder('utf-8', {ignoreBOM: true})

/** Seal a UTF-8 string into an `enc:v1:` envelope under `key` + `aad`. */
export const seal = async (
  key: CryptoKey,
  plaintext: string,
  aad: Uint8Array<ArrayBuffer>,
): Promise<string> => {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad },
      key,
      utf8Encode.encode(plaintext),
    ),
  )
  return encodeEnvelope(nonce, ciphertext)
}

/** Open an `enc:v1:` envelope, returning the UTF-8 plaintext. Throws on
 *  AEAD failure (wrong key, tampered ciphertext, or mismatched AAD). */
export const open = async (
  key: CryptoKey,
  envelope: string,
  aad: Uint8Array<ArrayBuffer>,
): Promise<string> => {
  const { nonce, ciphertext } = decodeEnvelope(envelope)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad },
    key,
    ciphertext,
  )
  return utf8Decode.decode(plaintext)
}
