// reconcileList.spec.ts
import { describe, it, expect } from 'vitest'
import { reconcileList } from '../array.ts'

// Helper type + key extractor used in all tests
interface Item { id: string; value?: number }
const keyOf = (i: Item) => i.id

describe('reconcileList', () => {
  it('does nothing when list already matches desired', () => {
    const a: Item = { id: 'a', value: 1 }
    const b: Item = { id: 'b', value: 2 }

    const list    = [a, b]
    const desired = [a, b]

    reconcileList(list, desired, keyOf)
    expect(list).toEqual(desired)          // deep equality
    expect(list[0]).toBe(a)                // reference preserved
  })

  it('removes obsolete items', () => {
    const list    = [{ id: 'a' }, { id: 'b' }, { id: 'obsolete' }]
    const desired = [{ id: 'a' }, { id: 'b' }]

    reconcileList(list, desired, keyOf)
    expect(list.map(keyOf)).toEqual(['a', 'b'])
  })

  it('appends missing items (preserving original order)', () => {
    const a = { id: 'a' }
    const b = { id: 'b' }
    const c = { id: 'c' }

    const list    = [a, b]
    const desired = [a, b, c]

    reconcileList(list, desired, keyOf)
    expect(list).toEqual([a, b, c])
    expect(list[2]).toBe(c)                // same reference pushed
  })

  it('removes and appends in one pass', () => {
    const b = { id: 'b' }
    const c = { id: 'c' }

    const list    = [{ id: 'a' }, b]       // a will be pruned
    const desired = [b, c]                 // c will be added

    reconcileList(list, desired, keyOf)
    expect(list).toEqual([b, c])
  })

  it('clears the list when desired is empty', () => {
    const list    = [{ id: 'a' }, { id: 'b' }]
    const desired: Item[] = []

    reconcileList(list, desired, keyOf)
    expect(list.length).toBe(0)
  })
})
