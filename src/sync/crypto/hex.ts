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
