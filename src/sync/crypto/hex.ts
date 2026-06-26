/**
 * Lowercase-hex encoding for raw bytes — a sibling primitive to
 * base64url.ts / base32.ts. Used by the asset content hash
 * (sha256 → `sha256:<hex>`, contentHash.ts) and, later, the content-addressed
 * Storage path (HMAC(K_id, sha256) → hex, §10).
 */

const HEX_ALPHABET = '0123456789abcdef'

/** Encode bytes as a lowercase, two-chars-per-byte hex string. */
export const bytesToHex = (bytes: Uint8Array): string => {
  let out = ''
  for (const byte of bytes) {
    out += HEX_ALPHABET[byte >> 4] + HEX_ALPHABET[byte & 0x0f]
  }
  return out
}

/** Decode a hex string (the inverse of {@link bytesToHex}) back to bytes —
 *  used to recover the raw sha256 digest from the stored `sha256:<hex>` content
 *  hash before re-deriving the content-addressed Storage path (§10). Strict: an
 *  odd length or any non-hex character throws, so a malformed stored hash
 *  fails closed at the resolver rather than producing a bogus path. */
export const hexToBytes = (hex: string): Uint8Array<ArrayBuffer> => {
  if (hex.length % 2 !== 0) {
    throw new Error(`hexToBytes: odd-length hex string (${hex.length} chars)`)
  }
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    // parseInt is lax (stops at the first non-hex, returns NaN only when the
    // FIRST char is non-hex), so validate each pair explicitly.
    if (!/^[0-9a-fA-F]{2}$/.test(hex.slice(i * 2, i * 2 + 2))) {
      throw new Error(`hexToBytes: non-hex characters at offset ${i * 2}`)
    }
    out[i] = byte
  }
  return out
}
