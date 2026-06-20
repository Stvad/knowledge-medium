import { stableJsonValue } from './internals/jsonCanonical'

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
 *                              source-only entries (dedupe keyed by the
 *                              persisted-JSON form: key-order-insensitive).
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
  for (const item of [...into, ...from]) {
    const key = dedupeKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/**
 * Dedupe key for a list item, aligned with how the merged result is persisted.
 *
 * Merged properties are stored via `JSON.stringify`, so the equivalence that
 * matters is the persisted-JSON one: object key order is irrelevant and
 * `NaN`/`undefined` collapse to `null`. `stableJsonValue` sorts object keys
 * (fixing the key-order-sensitivity that left reordered-equal objects as
 * duplicates), and wrapping the item in an array before `JSON.stringify`
 * normalizes `NaN`/`undefined` array elements to `null` exactly as the real
 * `properties_json` serialization does — so we never keep two items the
 * storage layer would persist as identical.
 */
const dedupeKey = (item: unknown): string =>
  JSON.stringify(stableJsonValue([item]))
