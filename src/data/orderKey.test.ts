// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  keyAfterIndex,
  keyAtEnd,
  keyAtStart,
  keyBeforeIndex,
  keyBetween,
  keysAfterIndex,
  keysBeforeIndex,
  keysBetween,
} from './orderKey'

describe('orderKey helpers', () => {
  it('keyBetween(null, null) yields a key that sorts deterministically (start of empty list)', () => {
    const k = keyBetween(null, null)
    expect(typeof k).toBe('string')
    expect(k.length).toBeGreaterThan(0)
  })

  it('keyBetween(null, x) sorts before x', () => {
    const x = keyBetween(null, null)
    const before = keyBetween(null, x)
    expect(before < x).toBe(true)
  })

  it('keyBetween(x, null) sorts after x', () => {
    const x = keyBetween(null, null)
    const after = keyBetween(x, null)
    expect(after > x).toBe(true)
  })

  it('keyBetween(a, b) yields a key strictly between a and b', () => {
    const a = keyBetween(null, null)
    const b = keyBetween(a, null)
    expect(a < b).toBe(true)  // sanity
    const mid = keyBetween(a, b)
    expect(a < mid && mid < b).toBe(true)
  })

  it('keysBetween emits ascending keys all between the bounds', () => {
    const a = keyBetween(null, null)
    const b = keyBetween(a, null)
    const middle = keysBetween(a, b, 5)
    expect(middle).toHaveLength(5)
    const full = [a, ...middle, b]
    for (let i = 1; i < full.length; i++) {
      expect(full[i - 1] < full[i]).toBe(true)
    }
  })

  it('keyAtStart / keyAtEnd surround a singleton sibling', () => {
    const sole = keyBetween(null, null)
    const first = keyAtStart(sole)
    const last = keyAtEnd(sole)
    expect(first < sole).toBe(true)
    expect(sole < last).toBe(true)
  })

  it('only emits base62 chars (no `!`, no path-encoding-breaking characters)', () => {
    // The path encoding in §11.1 uses `!` (0x21) as in-segment separator;
    // order_keys must stay in [0-9A-Za-z] so they cannot collide with it.
    const samples: string[] = []
    let cur: string | null = null
    for (let i = 0; i < 50; i++) {
      const next: string = keyBetween(cur, null)
      samples.push(next)
      cur = next
    }
    for (const k of samples) expect(k).toMatch(/^[0-9A-Za-z]+$/)
  })

  it('jittering reduces collisions: 100 concurrent inserts at the same slot collide rarely', () => {
    const a = keyBetween(null, null)
    const b = keyBetween(a, null)
    const collisions = new Map<string, number>()
    for (let i = 0; i < 100; i++) {
      const k = keyBetween(a, b)
      collisions.set(k, (collisions.get(k) ?? 0) + 1)
    }
    // With jittering enabled, the vast majority of these 100 should be
    // distinct. We allow some duplicates (the residue the (order_key, id)
    // tiebreak handles) but at least 80% of inserts should produce
    // unique keys.
    expect(collisions.size).toBeGreaterThanOrEqual(80)
  })
})

describe('tie-safe index helpers (A1)', () => {
  // keys are ascending `(order_key, id)`-sorted sibling order_keys. A tied run
  // shares one value; the helpers must NEVER feed `keyBetween(equal, equal)`.

  it('keyAfterIndex on a non-tied anchor sits strictly between it and the next key', () => {
    const keys = ['a0', 'a1', 'a2']
    const k = keyAfterIndex(keys, 1)
    expect('a1' < k && k < 'a2').toBe(true)
  })

  it('keyAfterIndex on a tied anchor widens past the whole run to the next distinct key', () => {
    // a1 appears 3×; inserting "after" any member must land after the run.
    const keys = ['a0', 'a1', 'a1', 'a1', 'a3']
    for (const anchor of [1, 2, 3]) {
      const k = keyAfterIndex(keys, anchor)
      expect('a1' < k && k < 'a3').toBe(true)  // strictly after the run, before next distinct
    }
  })

  it('keyAfterIndex on the last tied member with no distinct successor lands after the run (upper=null)', () => {
    const keys = ['a0', 'a1', 'a1']
    const k = keyAfterIndex(keys, 2)
    expect(k > 'a1').toBe(true)
  })

  it('keyBeforeIndex on a tied anchor widens past the whole run to the previous distinct key', () => {
    const keys = ['a0', 'a1', 'a1', 'a1', 'a3']
    for (const anchor of [1, 2, 3]) {
      const k = keyBeforeIndex(keys, anchor)
      expect('a0' < k && k < 'a1').toBe(true)  // strictly before the run, after prev distinct
    }
  })

  it('keyBeforeIndex on the first tied member with no distinct predecessor lands before the run (lower=null)', () => {
    const keys = ['a1', 'a1', 'a3']
    const k = keyBeforeIndex(keys, 0)
    expect(k < 'a1').toBe(true)
  })

  it('keysAfterIndex / keysBeforeIndex return n ascending keys inside the widened gap', () => {
    const keys = ['a0', 'a1', 'a1', 'a3']
    const after = keysAfterIndex(keys, 1, 3)
    expect(after).toHaveLength(3)
    for (let i = 0; i < after.length; i++) {
      expect('a1' < after[i] && after[i] < 'a3').toBe(true)
      if (i > 0) expect(after[i - 1] < after[i]).toBe(true)
    }
    const before = keysBeforeIndex(keys, 1, 3)
    expect(before).toHaveLength(3)
    for (let i = 0; i < before.length; i++) {
      expect('a0' < before[i] && before[i] < 'a1').toBe(true)
      if (i > 0) expect(before[i - 1] < before[i]).toBe(true)
    }
  })
})
