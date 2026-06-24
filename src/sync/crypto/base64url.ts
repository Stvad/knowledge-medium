/**
 * Base64url (RFC 4648 §5, URL-safe alphabet, no padding) for the
 * `enc:v1:` ciphertext envelope (see ./envelope.ts).
 *
 * Thin wrapper over `@scure/base` (audited, zero-dep) so we don't carry a
 * hand-rolled codec. Wire envelopes must be paste-safe and free of
 * `+`/`/`/`=`, which `base64urlnopad` gives directly. Decoding is strict
 * (scure rejects any out-of-alphabet char and excess padding); we surface
 * those as a single `Error` so callers — and the AEAD verify in ./aead.ts,
 * the real integrity gate — see a uniform failure.
 */

import { base64urlnopad } from '@scure/base'

export const bytesToBase64Url = (bytes: Uint8Array): string =>
  base64urlnopad.encode(bytes)

// Returns an ArrayBuffer-backed view so the decoded bytes satisfy
// WebCrypto's BufferSource params downstream (envelope → aead) without a cast.
export const base64UrlToBytes = (value: string): Uint8Array<ArrayBuffer> => {
  try {
    // scure may hand back a SharedArrayBuffer-typed view; copy into a
    // fresh Uint8Array<ArrayBuffer> so the type is what WebCrypto wants.
    return Uint8Array.from(base64urlnopad.decode(value))
  } catch (cause) {
    throw new Error(`base64url: invalid input`, { cause })
  }
}
