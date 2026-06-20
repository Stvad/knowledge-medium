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
 *                              source-only entries (canonical-keyed dedupe:
 *                              key-order-insensitive, value-distinguishing).
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
    const key = canonicalKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Object.prototype.toString.call(value) === '[object Object]'

/**
 * Stable, value-distinguishing string key for list dedupe.
 *
 * `JSON.stringify` is unsuitable here on two counts: it is key-order-sensitive
 * (`{id,alias}` vs `{alias,id}` produce different strings for an equal object)
 * and value-lossy (`NaN`, `null`, and `undefined` all collapse to `"null"`,
 * conflating distinct values). This walker sorts object keys and type-tags
 * every leaf so equal values share a key and distinct values never collide —
 * strings are JSON-quoted so structural delimiters inside them can't be
 * confused with the encoding's own.
 */
const canonicalKey = (value: unknown): string => {
  if (value === null) return 'null'
  if (value === undefined) return 'undef'
  if (Array.isArray(value)) return `[${value.map(canonicalKey).join(',')}]`
  if (isPlainObject(value)) {
    const body = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalKey(value[k])}`)
      .join(',')
    return `{${body}}`
  }
  switch (typeof value) {
    case 'string':
      return `s:${JSON.stringify(value)}`
    case 'number':
      return Number.isNaN(value) ? 'n:NaN' : `n:${value}`
    case 'boolean':
      return `b:${value}`
    case 'bigint':
      return `B:${value}`
    default:
      // Functions/symbols shouldn't appear in encoded props; tag defensively.
      return `x:${String(value)}`
  }
}
