/**
 * Trim each entry, drop empties, and de-duplicate — first occurrence wins,
 * input order preserved. Non-array inputs and non-string entries are skipped,
 * so this doubles as defensive coercion for untrusted config values (e.g. a
 * codec decoding a stored list). Note this trims; for verbatim de-duplication
 * (no trimming) keep a dedicated helper.
 */
export const uniqueStrings = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}
