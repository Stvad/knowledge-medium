// @vitest-environment node
/**
 * Fuzz suite for the canonical-JSON helpers — see `src/test/fuzz.ts` for the
 * smoke/deep tier mechanics.
 *
 * Domain: JSON-ish values only, not `fc.anything()`. The module's contract
 * (jsonCanonical.ts header) is "are these two values equal once persisted as
 * JSON?" — block properties are stored via `JSON.stringify`, so the meaningful
 * input domain is what can reach that call: parse-round-trippable JSON plus
 * the lossy leaves the comparison deliberately collapses (`NaN` / `undefined`
 * / ±Infinity → null, `-0` → 0). BigInt is excluded because `JSON.stringify`
 * itself throws on it (per spec), and functions/symbols/cycles never reach
 * persistence — fuzzing them would test outside the documented domain.
 *
 * Oracles:
 * - `jsonValuesEqual` is an equivalence relation. This holds by construction
 *   today (it compares canonical stringify outputs, jsonCanonical.ts:40-41);
 *   the properties lock the contract against a future reimplementation.
 * - `stableJsonValue` is idempotent, and canonicalizing is a no-op under the
 *   equivalence.
 * - Key insertion order is irrelevant at every nesting level, including own
 *   `__proto__` keys — the implementation routes every key through
 *   `defineProperty` so `__proto__` stays an own property
 *   (jsonCanonical.ts:26-35).
 */
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { fuzzParams } from '@/test/fuzz'
import { jsonValuesEqual, stableJsonValue } from './jsonCanonical'

const leafArb = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.constant(NaN),
  fc.constant(Infinity),
  fc.constant(-Infinity),
  fc.constant(-0),
  fc.boolean(),
  fc.double(),
  fc.integer(),
  fc.string({maxLength: 8}),
)

// Small pool so different objects share keys often; includes names that live
// on Object.prototype to probe the own-property handling.
const keyArb = fc.oneof(
  {arbitrary: fc.constantFrom('a', 'b', 'id', 'alias', '__proto__', 'constructor', 'toString'), weight: 3},
  {arbitrary: fc.string({maxLength: 5}), weight: 1},
)

const {jsonish: jsonishArb} = fc.letrec<{jsonish: unknown}>(tie => ({
  jsonish: fc.oneof(
    {maxDepth: 3},
    {arbitrary: leafArb, weight: 4},
    {arbitrary: fc.array(tie('jsonish'), {maxLength: 4}), weight: 1},
    {arbitrary: fc.dictionary(keyArb, tie('jsonish'), {maxKeys: 4}), weight: 1},
  ),
}))

/** Guaranteed own `__proto__` data property (fc.dictionary only sometimes
 *  produces one) — mirrors what `JSON.parse` materializes from stored JSON. */
const ownProtoObjArb = jsonishArb.map(v => {
  const out: Record<string, unknown> = {id: 'p'}
  Object.defineProperty(out, '__proto__', {value: v, enumerable: true, writable: true, configurable: true})
  return out
})

const valueArb = fc.oneof({arbitrary: jsonishArb, weight: 5}, {arbitrary: ownProtoObjArb, weight: 1})

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  Object.prototype.toString.call(v) === '[object Object]'

/** Same value, reversed key insertion order at every nesting level. Uses
 *  `defineProperty` so an own `__proto__` key survives the rebuild (plain
 *  assignment would route it through the prototype setter and drop it,
 *  which would be a bug in this helper, not in the target). */
const reorderDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(reorderDeep)
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).reverse()) {
    Object.defineProperty(out, key, {
      value: reorderDeep(value[key]),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return out
}

const canon = (v: unknown): string | undefined => JSON.stringify(stableJsonValue(v))

describe('jsonCanonical fuzz', () => {
  it('never throws on the JSON-ish domain; jsonValuesEqual is reflexive', () => {
    fc.assert(
      fc.property(valueArb, v => {
        stableJsonValue(v)
        expect(jsonValuesEqual(v, v)).toBe(true)
      }),
      fuzzParams(200),
    )
  })

  it('jsonValuesEqual is symmetric', () => {
    const pairArb = fc.oneof(
      fc.tuple(valueArb, valueArb),
      valueArb.map(v => [v, reorderDeep(v)] as [unknown, unknown]),
    )
    fc.assert(
      fc.property(pairArb, ([a, b]) => {
        expect(jsonValuesEqual(a, b)).toBe(jsonValuesEqual(b, a))
      }),
      fuzzParams(150),
    )
  })

  it('jsonValuesEqual is transitive (equal-biased triples)', () => {
    // Derive b and c from a by identity/key-reordering often enough that the
    // premise a~b && b~c is frequently true (a fully independent triple would
    // make the implication vacuous almost always).
    const deriveArb = fc.constantFrom<'same' | 'reorder' | 'other'>('same', 'reorder', 'other')
    const tripleArb = fc
      .tuple(valueArb, valueArb, valueArb, deriveArb, deriveArb)
      .map(([x, o1, o2, d1, d2]) => {
        const derive = (how: 'same' | 'reorder' | 'other', other: unknown): unknown =>
          how === 'same' ? x : how === 'reorder' ? reorderDeep(x) : other
        return [x, derive(d1, o1), derive(d2, o2)] as [unknown, unknown, unknown]
      })
    fc.assert(
      fc.property(tripleArb, ([a, b, c]) => {
        fc.pre(jsonValuesEqual(a, b) && jsonValuesEqual(b, c))
        expect(jsonValuesEqual(a, c)).toBe(true)
      }),
      fuzzParams(150),
    )
  })

  it('stableJsonValue is idempotent and equivalence-preserving', () => {
    fc.assert(
      fc.property(valueArb, v => {
        const once = stableJsonValue(v)
        // "Deep-equals" in the only sense the module defines: identical
        // persisted-JSON form (leaves are returned as-is, so no other
        // component of the value can differ).
        expect(canon(once)).toBe(canon(stableJsonValue(once)))
        // Canonicalizing never changes what would be persisted.
        expect(jsonValuesEqual(once, v)).toBe(true)
      }),
      fuzzParams(200),
    )
  })

  it('key insertion order is irrelevant at every nesting level', () => {
    fc.assert(
      fc.property(valueArb, v => {
        const reordered = reorderDeep(v)
        expect(jsonValuesEqual(v, reordered)).toBe(true)
        expect(canon(v)).toBe(canon(reordered))
      }),
      fuzzParams(200),
    )
  })

  it('jsonValuesEqual(a, b) ⟺ canonical stringify forms are identical', () => {
    // Definitionally true of the current implementation (jsonCanonical.ts:
    // 40-41); kept as the contract the rest of the data layer relies on
    // (tx no-op detection and mergeProperties dedupe key must agree).
    const pairArb = fc.oneof(
      fc.tuple(valueArb, valueArb),
      valueArb.map(v => [v, reorderDeep(v)] as [unknown, unknown]),
    )
    fc.assert(
      fc.property(pairArb, ([a, b]) => {
        expect(jsonValuesEqual(a, b)).toBe(canon(a) === canon(b))
      }),
      fuzzParams(150),
    )
  })
})
