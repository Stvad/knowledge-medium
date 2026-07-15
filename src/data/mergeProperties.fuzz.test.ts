// @vitest-environment node
/**
 * Fuzz suite for `mergeProperties` — see `src/test/fuzz.ts` for the
 * smoke/deep tier mechanics.
 *
 * Oracles (each checked against mergeProperties.ts, not assumed):
 * - purity: inputs never mutated (raw-JSON snapshot, same technique as the
 *   example test at mergeProperties.test.ts:134).
 * - identities: merge(x, {}) is a shallow copy of x; merge({}, x) copies
 *   source values VERBATIM — the define-not-assign copy writes `fromVal`
 *   untouched (`Object.defineProperty(..., {value: fromVal, ...})`,
 *   mergeProperties.ts:36-44)
 *   does no array canonicalization/dedup on the way in, so both identities
 *   hold up to raw JSON form.
 * - associativity holds only on KIND-CONSISTENT bags (each key is array-typed
 *   in every bag that carries it, or non-array in every bag). With type
 *   drift it genuinely fails by design, e.g.
 *     x = {k: ['a']}, y = {k: 's'}, z = {k: ['b']}
 *     merge(merge(x,y),z) = {k: ['a','b']}  vs  merge(x,merge(y,z)) = {k: ['a']}
 *   because an array/non-array collision takes the documented "otherwise →
 *   target wins" fallback (the fallthrough at mergeProperties.ts:50-51;
 *   exercised as intended
 *   behavior by mergeProperties.test.ts:72-76), which discards the source
 *   array that the other association order would have unioned. That fallback
 *   is the spec, so the associativity oracle is scoped, not weakened.
 * - array union: first-occurrence dedup of target++source, keyed by the
 *   persisted-JSON form. The model below re-derives expected output from the
 *   documented equivalence (`JSON.stringify(stableJsonValue([item]))`,
 *   `dedupeKey`, mergeProperties.ts:68-81) — key-order-insensitive, NaN/undefined
 *   collapsing to null exactly as the stored array does.
 * - idempotence: merge(x, x) ≡ x is FALSE when an array in x carries internal
 *   duplicates (union dedups them); the true law is merge(x, x) = x with each
 *   array first-occurrence-deduped. (Merge is not idempotent on its own image
 *   either — single-sided arrays pass through undeduped; see the property.)
 *
 * Historical find: an earlier `!(key in out)` gate silently dropped a
 * source-only key shadowing an Object.prototype member
 * (mergeProperties({}, {constructor: 1}) → {}). Fixed to Object.hasOwn +
 * define-not-assign; the top-level key pool now includes such names so
 * the class stays covered. (Own `__proto__` keys are pinned by example
 * tests in mergeProperties.test.ts — fc.dictionary's construction of a
 * literal '__proto__' generated key is not guaranteed to produce an own
 * key, so it stays out of the generator pool.)
 */
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { fuzzParams } from '@/test/fuzz'
import { mergeProperties } from './mergeProperties'
import { jsonValuesEqual, stableJsonValue } from './internals/jsonCanonical'

// ──── Generators ────

// Top-level property names. Small pool so key collisions actually happen.
// 'constructor'/'toString' shadow Object.prototype members — the class the
// historical `in`-gate bug dropped (see header).
const KEY_POOL = ['a', 'b', 'c', 'refs', 'xs', 'constructor', 'toString'] as const
const keyArb = fc.constantFrom(...KEY_POOL)

// Tiny scalar domains so array items collide under dedup often.
const scalarArb = fc.oneof(
  fc.constantFrom('a', 'b', 'c'),
  fc.integer({min: 0, max: 3}),
  fc.boolean(),
  fc.constant(null),
)

/** Same entries, reversed insertion order — `defineProperty` so an own
 *  `__proto__` item key survives the rebuild. */
const reversedKeys = (obj: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(obj).reverse()) {
    Object.defineProperty(out, key, {
      value: obj[key],
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return out
}

// Small objects as array items (refList-like), sometimes with reversed key
// insertion order so dedup must be key-order-insensitive to collapse them.
const itemObjArb = fc
  .tuple(
    fc.dictionary(fc.constantFrom('id', 'alias', 't', '__proto__'), scalarArb, {maxKeys: 3}),
    fc.boolean(),
  )
  .map(([obj, reverse]) => (reverse ? reversedKeys(obj) : obj))

// NaN/undefined appear as array items only: their dedup key collapses to
// null (`dedupeKey`, mergeProperties.ts:68-81), which the model below must reproduce.
const itemArb = fc.oneof(
  {arbitrary: scalarArb, weight: 4},
  {arbitrary: itemObjArb, weight: 2},
  {arbitrary: fc.constantFrom(NaN, undefined), weight: 1},
)

const arrayArb = fc.array(itemArb, {maxLength: 5})
const nestedObjArb = fc.dictionary(fc.constantFrom('id', 'alias', 't'), scalarArb, {maxKeys: 3})
const plainValueArb = fc.oneof({arbitrary: scalarArb, weight: 3}, {arbitrary: nestedObjArb, weight: 1})
const valueArb = fc.oneof(
  {arbitrary: plainValueArb, weight: 2},
  {arbitrary: arrayArb, weight: 3},
)

/** General bags: kinds may drift per key across bags (exercises the
 *  array/non-array collision fallback). */
const bagArb = fc.dictionary(keyArb, valueArb, {maxKeys: KEY_POOL.length})

/** Kind-consistent bags: each pool key has a fixed kind in every bag —
 *  the domain on which associativity is a real law (see header). */
const consistentBagArb = fc.record(
  {a: plainValueArb, b: plainValueArb, c: plainValueArb, refs: arrayArb, xs: arrayArb},
  {requiredKeys: []},
)

// ──── Reference model for the array union ────

/** The documented persisted-JSON dedup key (`dedupeKey`, mergeProperties.ts:68-81). */
const canonKey = (item: unknown): string => JSON.stringify(stableJsonValue([item]))

const dedupeFirstOccurrence = (items: readonly unknown[]): unknown[] => {
  const seen = new Set<string>()
  const out: unknown[] = []
  for (const item of items) {
    const key = canonKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/** Element-wise identity (Object.is — items must be passed through
 *  untouched, not cloned or canonicalized). */
const expectSameItems = (actual: unknown, expected: unknown[]) => {
  expect(Array.isArray(actual)).toBe(true)
  const arr = actual as unknown[]
  expect(arr).toHaveLength(expected.length)
  expected.forEach((item, i) => expect(Object.is(arr[i], item)).toBe(true))
}

// ──── Properties ────

describe('mergeProperties fuzz', () => {
  it('never mutates its inputs', () => {
    fc.assert(
      fc.property(bagArb, bagArb, (into, from) => {
        const intoSnap = JSON.stringify(into)
        const fromSnap = JSON.stringify(from)
        mergeProperties(into, from)
        expect(JSON.stringify(into)).toBe(intoSnap)
        expect(JSON.stringify(from)).toBe(fromSnap)
      }),
      fuzzParams(150),
    )
  })

  it('empty bag is a two-sided identity (verbatim values, raw JSON form)', () => {
    fc.assert(
      fc.property(bagArb, x => {
        // Left: `{...intoProps}` (mergeProperties.ts:27) preserves order+values.
        expect(JSON.stringify(mergeProperties(x, {}))).toBe(JSON.stringify(x))
        // Right: source values are copied verbatim (define-not-assign,
        // mergeProperties.ts:36-44);
        // arrays are NOT deduped on the way in, so this holds even when x's
        // arrays contain internal duplicates.
        expect(JSON.stringify(mergeProperties({}, x))).toBe(JSON.stringify(x))
      }),
      fuzzParams(150),
    )
  })

  it('associative on kind-consistent bags (persisted-JSON equivalence)', () => {
    fc.assert(
      fc.property(consistentBagArb, consistentBagArb, consistentBagArb, (x, y, z) => {
        const lhs = mergeProperties(mergeProperties(x, y), z)
        const rhs = mergeProperties(x, mergeProperties(y, z))
        expect(jsonValuesEqual(lhs, rhs)).toBe(true)
      }),
      fuzzParams(120),
    )
  })

  it('target wins on non-array collisions, preserving the exact target value', () => {
    fc.assert(
      fc.property(bagArb, bagArb, keyArb, plainValueArb, plainValueArb, (x, y, k, tv, sv) => {
        const into = {...x, [k]: tv}
        const from = {...y, [k]: sv}
        // Collision with a non-array on the target side is never rewritten
        // (the target-wins fallthrough, mergeProperties.ts:50-51) — the
        // reference survives, covering both
        // "deep-equal → keep target" and "otherwise → target wins".
        expect(Object.is(mergeProperties(into, from)[k], tv)).toBe(true)
      }),
      fuzzParams(150),
    )
  })

  it('array∪array follows the first-occurrence persisted-JSON dedup model', () => {
    fc.assert(
      fc.property(bagArb, bagArb, keyArb, arrayArb, arrayArb, (x, y, k, ta, sa) => {
        const result = mergeProperties({...x, [k]: ta}, {...y, [k]: sa})[k]
        // Target items first (their original order), then unseen source
        // items; duplicates collapse under the persisted-JSON key; surviving
        // items are the original references.
        expectSameItems(result, dedupeFirstOccurrence([...ta, ...sa]))
      }),
      fuzzParams(150),
    )
  })

  it('merge(x, x) = x with each array internally deduped', () => {
    // NOT merge(x,x) ≡ x: the union dedups internal duplicates the identity
    // would have to keep. And merge is NOT idempotent on its own image
    // either: union runs only for keys present in BOTH bags
    // (the source-only copy path, mergeProperties.ts:36-44), so
    // single-sided arrays pass through
    // verbatim and the image can carry internal duplicates — e.g.
    // m = merge({a: ['b','b']}, {}) = {a: ['b','b']}, merge(m, m) = {a: ['b']}
    // (found by an earlier draft of this property). The law below is the one
    // the code actually guarantees.
    fc.assert(
      fc.property(bagArb, x => {
        const twice = mergeProperties(x, x)
        expect(Object.keys(twice)).toEqual(Object.keys(x))
        for (const k of Object.keys(x)) {
          const v = x[k]
          if (Array.isArray(v)) expectSameItems(twice[k], dedupeFirstOccurrence(v))
          else expect(Object.is(twice[k], v)).toBe(true)
        }
      }),
      fuzzParams(120),
    )
  })
})
