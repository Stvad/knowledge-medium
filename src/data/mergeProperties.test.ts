import { describe, expect, it } from 'vitest'
import { mergeProperties } from './mergeProperties'

describe('mergeProperties', () => {
  it('returns target unchanged when source is empty', () => {
    expect(mergeProperties({a: 1, b: 'x'}, {})).toEqual({a: 1, b: 'x'})
  })

  it('returns source unchanged when target is empty', () => {
    expect(mergeProperties({}, {a: 1, b: 'x'})).toEqual({a: 1, b: 'x'})
  })

  it('keeps source-only keys', () => {
    expect(mergeProperties({a: 1}, {b: 2})).toEqual({a: 1, b: 2})
  })

  it('target wins on scalar collision', () => {
    expect(mergeProperties({a: 1}, {a: 2})).toEqual({a: 1})
    expect(mergeProperties({a: 'into'}, {a: 'from'})).toEqual({a: 'into'})
    expect(mergeProperties({a: true}, {a: false})).toEqual({a: true})
  })

  it('keeps single value when both sides are deep-equal', () => {
    expect(mergeProperties({a: {x: 1}}, {a: {x: 1}})).toEqual({a: {x: 1}})
  })

  it('target wins on object collision (no recursive merge)', () => {
    // Objects that aren't deep-equal collide as scalars: target wins.
    // (Matches the codec model — non-list values are opaque blobs.)
    expect(mergeProperties({a: {x: 1}}, {a: {x: 2}})).toEqual({a: {x: 1}})
  })

  describe('array union', () => {
    it('concatenates with target order first, source-only items after', () => {
      expect(mergeProperties({xs: ['a', 'b']}, {xs: ['c', 'd']}))
        .toEqual({xs: ['a', 'b', 'c', 'd']})
    })

    it('dedupes overlapping primitives', () => {
      expect(mergeProperties({xs: ['a', 'b']}, {xs: ['b', 'c']}))
        .toEqual({xs: ['a', 'b', 'c']})
    })

    it('handles full overlap (target wins, no duplication)', () => {
      expect(mergeProperties({xs: ['a', 'b']}, {xs: ['a', 'b']}))
        .toEqual({xs: ['a', 'b']})
    })

    it('preserves target order even when source orders differ', () => {
      expect(mergeProperties({xs: ['b', 'a']}, {xs: ['a', 'b', 'c']}))
        .toEqual({xs: ['b', 'a', 'c']})
    })

    it('dedupes structured items (e.g. refList encoded shape)', () => {
      // refList codec encodes BlockReference to {id, alias}; merging two
      // refList properties should treat identical {id, alias} as duplicates.
      const into = {refs: [{id: 'x', alias: 'X'}, {id: 'y', alias: 'Y'}]}
      const from = {refs: [{id: 'y', alias: 'Y'}, {id: 'z', alias: 'Z'}]}
      expect(mergeProperties(into, from)).toEqual({
        refs: [{id: 'x', alias: 'X'}, {id: 'y', alias: 'Y'}, {id: 'z', alias: 'Z'}],
      })
    })

    it('treats structurally-different items as distinct', () => {
      // {id: 'x', alias: 'X'} and {id: 'x', alias: 'Y'} differ; both kept.
      expect(mergeProperties(
        {refs: [{id: 'x', alias: 'X'}]},
        {refs: [{id: 'x', alias: 'Y'}]},
      )).toEqual({refs: [{id: 'x', alias: 'X'}, {id: 'x', alias: 'Y'}]})
    })

    it('falls back to target-wins when only one side is an array', () => {
      // Type drift across encodings shouldn't crash; collision rule applies.
      expect(mergeProperties({a: ['x']}, {a: 'x'})).toEqual({a: ['x']})
      expect(mergeProperties({a: 'x'}, {a: ['x']})).toEqual({a: 'x'})
    })

    it('handles empty arrays without producing duplicates', () => {
      expect(mergeProperties({xs: []}, {xs: ['a']})).toEqual({xs: ['a']})
      expect(mergeProperties({xs: ['a']}, {xs: []})).toEqual({xs: ['a']})
      expect(mergeProperties({xs: []}, {xs: []})).toEqual({xs: []})
    })

    // #196: the dedupe key is the persisted-JSON form, so it must be
    // key-order-insensitive (the real bug) and consistent with how the merged
    // result is stored (JSON.stringify collapses NaN/undefined to null).
    it('dedupes reordered-equal objects regardless of key order', () => {
      // {id, alias} vs {alias, id} encode the same value; keep one.
      expect(
        mergeProperties({refs: [{id: 'x', alias: 'A'}]}, {refs: [{alias: 'A', id: 'x'}]}).refs,
      ).toHaveLength(1)
    })

    it('aligns dedupe with the persisted-JSON form (no stored duplicates)', () => {
      // The merged array is persisted via JSON.stringify, so the contract is
      // that the *stored* form carries no duplicate the dedupe should have
      // collapsed. Assert on the round-tripped value, not just in-memory length.
      const objs = mergeProperties({refs: [{id: 'x', alias: 'A'}]}, {refs: [{alias: 'A', id: 'x'}]})
      expect(JSON.parse(JSON.stringify(objs.refs))).toEqual([{id: 'x', alias: 'A'}])

      // NaN/undefined serialize as null, so collapsing them is deliberate:
      // distinguishing them would persist [null, null] / [[null], [null]].
      expect(JSON.parse(JSON.stringify(mergeProperties({xs: [NaN]}, {xs: [null]}).xs))).toEqual([null])
      expect(JSON.parse(JSON.stringify(mergeProperties({xs: [[undefined]]}, {xs: [[null]]}).xs)))
        .toEqual([[null]])
    })

    it('keeps items that differ only in an own __proto__ key', () => {
      // JSON.parse materializes __proto__ as a real own key that JSON.stringify
      // persists, so these two items are genuinely distinct and must not
      // collapse (regression guard for the canonical-key __proto__ handling).
      const a = JSON.parse('{"__proto__": {"t": "dark"}, "id": "p"}')
      const b = JSON.parse('{"id": "p", "__proto__": {"t": "light"}}')
      expect(mergeProperties({opts: [a]}, {opts: [b]}).opts).toHaveLength(2)
    })
  })

  it('does not mutate input bags', () => {
    const into = {xs: ['a'], scalar: 1}
    const from = {xs: ['b'], other: 2}
    const intoSnap = JSON.stringify(into)
    const fromSnap = JSON.stringify(from)
    mergeProperties(into, from)
    expect(JSON.stringify(into)).toBe(intoSnap)
    expect(JSON.stringify(from)).toBe(fromSnap)
  })
})
