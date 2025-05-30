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
