import { describe, expect, it } from 'vitest'
import { jsonValuesEqual, stableJsonValue } from './jsonCanonical'

describe('jsonCanonical', () => {
  describe('jsonValuesEqual', () => {
    it('ignores object key order', () => {
      expect(jsonValuesEqual({id: 'x', alias: 'A'}, {alias: 'A', id: 'x'})).toBe(true)
    })

    it('distinguishes values that persist differently', () => {
      expect(jsonValuesEqual({a: 1}, {a: 2})).toBe(false)
    })

    it('treats NaN/undefined as null (matching JSON persistence)', () => {
      expect(jsonValuesEqual([NaN], [null])).toBe(true)
      expect(jsonValuesEqual([undefined], [null])).toBe(true)
    })

    it('does not collapse values differing only in an own __proto__ key', () => {
      // __proto__ from JSON.parse is a real own key that JSON.stringify
      // persists, so a write touching only it must not be judged a no-op.
      const before = JSON.parse('{"__proto__": {"t": "dark"}}')
      const after = JSON.parse('{"__proto__": {"t": "light"}}')
      expect(jsonValuesEqual(before, after)).toBe(false)
    })
  })

  describe('stableJsonValue', () => {
    it('canonicalizes nested key order so the JSON form is stable', () => {
      const a = JSON.stringify(stableJsonValue({b: {d: 1, c: 2}, a: 3}))
      const b = JSON.stringify(stableJsonValue({a: 3, b: {c: 2, d: 1}}))
      expect(a).toBe(b)
    })

    it('preserves an own __proto__ key in the JSON form', () => {
      const value = JSON.parse('{"__proto__": {"t": "dark"}, "id": "p"}')
      const out = stableJsonValue(value)
      expect(Object.keys(out as object).sort()).toEqual(['__proto__', 'id'])
      expect(JSON.stringify(out)).toBe('{"__proto__":{"t":"dark"},"id":"p"}')
    })
  })
})
