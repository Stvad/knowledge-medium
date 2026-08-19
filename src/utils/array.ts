/**
 * Mutate `list` so its contents (order preserved) match `desired`.
 *
 * @param list     The mutable list to update
 * @param desired  The target contents
 * @param keyOf    How to obtain a unique key from an item
 */
export function reconcileList<T, K>(
  list: Array<T>,
  desired: readonly T[],
  keyOf: (item: T) => K,
): void {
  // 1️⃣  Fast membership sets
  const want = new Set(desired.map(keyOf))
  const kept = new Set<K>()

  // 2️⃣  Delete obsolete items (walk back so indices stay valid)
  for (let i = list.length - 1; i >= 0; i--) {
    const k = keyOf(list[i])
    if (!want.has(k)) {
      list.splice(i, 1)
    } else {
      kept.add(k)              // remember we already have it
    }
  }

  // 3️⃣  Append the newcomers
  for (const item of desired) {
    const k = keyOf(item)
    if (!kept.has(k)) list.push(item)  // one list-insert op
  }
}

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
