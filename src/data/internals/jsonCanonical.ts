/**
 * Canonical JSON value helpers — the single source of truth for "are these
 * two values equal once persisted as JSON?".
 *
 * Block properties/references are stored via `JSON.stringify(...)`, so the
 * equivalence that matters everywhere downstream is the persisted-JSON one:
 *   - object key order is irrelevant (storage round-trips either order), and
 *   - `NaN` / `undefined` collapse to `null` (JSON has no other encoding).
 *
 * `stableJsonValue` canonicalizes by sorting object keys recursively;
 * `jsonValuesEqual` compares two values under that canonical form. The tx
 * engine uses these for no-op detection; `persistedJsonKey` is the Set/Map key
 * form, so nothing folds two values the storage layer would keep apart, or
 * keeps two it would persist as one.
 */

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Object.prototype.toString.call(value) === '[object Object]'

export const stableJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableJsonValue)
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    // `out[key] = …` would route a literal `__proto__` key through the
    // prototype setter instead of creating an own property, dropping it from
    // the JSON form — whereas storage (`JSON.stringify` of a `JSON.parse`d
    // value) keeps it. `defineProperty` makes every key, `__proto__` included,
    // an own enumerable property so the canonical form matches what persists.
    Object.defineProperty(out, key, {
      value: stableJsonValue(value[key]),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return out
}

export const jsonValuesEqual = (a: unknown, b: unknown): boolean =>
  JSON.stringify(stableJsonValue(a)) === JSON.stringify(stableJsonValue(b))

/** A Set/Map key under which two values are the SAME once persisted.
 *
 *  Wrapping in an array before stringifying is what makes it total: bare
 *  `JSON.stringify(undefined)` returns the JS value `undefined` rather than a
 *  string, and `NaN` stringifies to `"null"` — so unwrapped, those two collide
 *  with a literal `null` inconsistently, while storage persists all three
 *  identically. Inside an array every one of them serializes as `null`, exactly
 *  as the real `properties_json` write does.
 *
 *  Asked wherever equal values must fold into one: `mergeProperties`' list
 *  union, and the value-child comparison in `propertyChildren`. */
export const persistedJsonKey = (value: unknown): string =>
  JSON.stringify(stableJsonValue([value]))
