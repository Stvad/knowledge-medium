import { persistedJsonKey } from './internals/jsonCanonical'

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
    // hasOwn, not `in`: `in` walks the prototype chain, so a source-only
    // key shadowing an Object.prototype member ('constructor', an own
    // '__proto__' from JSON.parse, …) looked "present" and was silently
    // dropped (found by mergeProperties.fuzz). Define, don't assign: a
    // plain `out[key] =` on a source-only '__proto__' key would invoke
    // the prototype setter instead of creating the own data property.
    if (!Object.hasOwn(out, key)) {
      Object.defineProperty(out, key, {
        value: fromVal,
        enumerable: true,
        writable: true,
        configurable: true,
      })
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
    const key = persistedJsonKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}


