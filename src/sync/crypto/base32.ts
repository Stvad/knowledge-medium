/**
 * Base32 (RFC 4648, no padding) for the user-facing workspace-key
 * format `kmp-wk-1:<base32>` (§5/§6). Base32 is paste-friendly across
 * messaging apps and legible on paper. 32 key bytes encode to 52 chars.
 *
 * Decoding is case-insensitive (users may retype) and rejects any
 * character outside the alphabet. The caller (./workspaceKey.ts) is
 * responsible for asserting the decoded byte length.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

const DECODE = (() => {
  const table = new Int16Array(128).fill(-1)
  for (let i = 0; i < ALPHABET.length; i++) {
    const c = ALPHABET.charCodeAt(i)
    table[c] = i
    // Lowercase alias only for letters (A–Z, codes 65–90). Doing this
    // unconditionally would corrupt the table: for a digit like '7'
    // (code 55), c + 32 = 87 = 'W', overwriting a real letter slot.
    if (c >= 65 && c <= 90) table[c + 32] = i
  }
  return table
})()

export const bytesToBase32 = (bytes: Uint8Array): string => {
  let out = ''
  let buffer = 0
  let bits = 0
  for (let i = 0; i < bytes.length; i++) {
    buffer = (buffer << 8) | bytes[i]
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += ALPHABET[(buffer >> bits) & 31]
    }
    // Keep only the `bits` live low bits. Without this, `buffer` grows
    // past 32 bits and JS's 32-bit bitwise ops corrupt it a few bytes in.
    buffer &= (1 << bits) - 1
  }
  if (bits > 0) {
    out += ALPHABET[(buffer << (5 - bits)) & 31]
  }
  return out
}

export const base32ToBytes = (value: string): Uint8Array<ArrayBuffer> => {
  const out: number[] = []
  let buffer = 0
  let bits = 0
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    const v = code < 128 ? DECODE[code] : -1
    if (v < 0) throw new Error('base32: invalid character')
    buffer = (buffer << 5) | v
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((buffer >> bits) & 0xff)
    }
    // Same masking as the encoder so `buffer` can't overflow 32 bits.
    buffer &= (1 << bits) - 1
  }
  return Uint8Array.from(out)
}
