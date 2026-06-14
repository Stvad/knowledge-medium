/**
 * Merge two encoded property bags into one. Used by `core.merge` to fold
 * the source block's properties into the target.
 *
 * Generic by design — knows nothing about specific property names; behaviour
 * is driven entirely by the encoded value's shape. That keeps the kernel
 * free of plugin coupling: list-coded properties (`alias`, `types`,
 * `refList`-flavoured props) get a natural set-union, and scalars get a
 * predictable target-wins rule.
 *
 * Rules per key:
 *   1. Key in only one side  → take that value.
 *   2. Both arrays           → concat with target order first, then
 *                              source-only entries (JSON-keyed dedupe).
 *   3. Both deep-equal       → keep target's value.
 *   4. Otherwise (collision) → target wins.
 *
 * Inputs are never mutated; a fresh object is returned.
 */
export const mergeProperties = (
  intoProps: Record<string, unknown>,
  fromProps: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {...intoProps}
  for (const key of Object.keys(fromProps)) {
    const fromVal = fromProps[key]
    if (!(key in out)) {
      out[key] = fromVal
      continue
    }
    const intoVal = out[key]
    if (Array.isArray(intoVal) && Array.isArray(fromVal)) {
      out[key] = unionArrays(intoVal, fromVal)
      continue
    }
    // Both present, scalar/object. Target wins; the deep-equal case is
    // covered for free because the result is identical either way.
  }
  return out
}

const unionArrays = (into: unknown[], from: unknown[]): unknown[] => {
  const seen = new Set<string>()
  const out: unknown[] = []
  for (const item of into) {
    const key = JSON.stringify(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  for (const item of from) {
    const key = JSON.stringify(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}
