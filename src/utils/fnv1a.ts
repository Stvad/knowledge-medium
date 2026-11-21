/** FNV-1a, 32-bit, returned as lowercase hex.
 *
 *  Not a security hash — a non-cryptographic mixer for cheap, stable,
 *  cross-device-identical fingerprints of short strings. Callers must be able
 *  to absorb a collision: at 32 bits it is rare but not negligible.
 *
 *  Hex output (rather than a number) so callers can embed it in an identifier
 *  or a SQL string literal without escaping — the charset is `[0-9a-f]`. */
export const fnv1a32Hex = (source: string): string => {
  let hash = 0x811c9dc5
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}
