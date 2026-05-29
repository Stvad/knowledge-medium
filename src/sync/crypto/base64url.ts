/**
 * Base64url (RFC 4648 §5, URL-safe alphabet, no padding) for the
 * `enc:v1:` ciphertext envelope (see ./envelope.ts).
 *
 * Wire envelopes must be paste-safe and free of `+`/`/`/`=`, so we use
 * the URL-safe alphabet and strip padding. Decoding is strict: it
 * rejects any character outside the alphabet and any length that can't
 * be a real base64 group (a data-char count of len % 4 === 1 is
 * impossible). This mirrors the server-side `is_enc_v1_envelope` shape
 * check (§7) — but here the real integrity gate is the AEAD verify in
 * ./aead.ts, so this only needs to reject bytes that can't decode at all.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

const DECODE = (() => {
  const table = new Int16Array(128).fill(-1)
  for (let i = 0; i < ALPHABET.length; i++) {
    table[ALPHABET.charCodeAt(i)] = i
  }
  return table
})()

export const bytesToBase64Url = (bytes: Uint8Array): string => {
  let out = ''
  let i = 0
  for (; i + 3 <= bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63]
  }
  const rem = bytes.length - i
  if (rem === 1) {
    const n = bytes[i] << 16
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63]
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63]
  }
  return out
}

// Returns an ArrayBuffer-backed view (not the wider ArrayBufferLike) so
// the decoded bytes satisfy WebCrypto's BufferSource params downstream
// (envelope → aead) without a cast.
export const base64UrlToBytes = (value: string): Uint8Array<ArrayBuffer> => {
  const len = value.length
  // A trailing group of exactly one data char can never be produced by a
  // real base64 encoding — reject rather than silently dropping bits.
  if (len % 4 === 1) {
    throw new Error('base64url: invalid length')
  }

  const fullGroups = Math.floor(len / 4)
  const rem = len - fullGroups * 4
  const outLen = fullGroups * 3 + (rem === 2 ? 1 : rem === 3 ? 2 : 0)
  const out = new Uint8Array(outLen)

  let o = 0
  let i = 0
  const sextet = (index: number): number => {
    const code = value.charCodeAt(index)
    const v = code < 128 ? DECODE[code] : -1
    if (v < 0) throw new Error('base64url: invalid character')
    return v
  }

  for (let g = 0; g < fullGroups; g++, i += 4) {
    const n = (sextet(i) << 18) | (sextet(i + 1) << 12) | (sextet(i + 2) << 6) | sextet(i + 3)
    out[o++] = (n >> 16) & 0xff
    out[o++] = (n >> 8) & 0xff
    out[o++] = n & 0xff
  }
  if (rem === 2) {
    const n = (sextet(i) << 18) | (sextet(i + 1) << 12)
    out[o] = (n >> 16) & 0xff
  } else if (rem === 3) {
    const n = (sextet(i) << 18) | (sextet(i + 1) << 12) | (sextet(i + 2) << 6)
    out[o] = (n >> 16) & 0xff
    out[o + 1] = (n >> 8) & 0xff
  }
  return out
}
