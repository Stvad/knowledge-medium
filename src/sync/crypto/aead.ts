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
const utf8Decode = new TextDecoder()

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
