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
