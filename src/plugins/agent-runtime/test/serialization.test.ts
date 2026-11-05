// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { serializeValue } from '../serialization.ts'

describe('serializeValue', () => {
  it('answers a value that reaches itself through an array instead of overflowing the stack', () => {
    const list: unknown[] = [1]
    list.push(list)
    const holder: {items: unknown[]} = {items: []}
    holder.items.push(holder)

    expect(serializeValue(list)).toEqual([1, '[Circular]'])
    expect(serializeValue(holder)).toEqual({items: ['[Circular]']})
  })

  it('serializes maps, sets and the values JSON cannot carry', () => {
    expect(serializeValue({
      map: new Map<unknown, unknown>([[1, 'one'], ['k', new Set([2n])]]),
      missing: undefined,
      fn: function named() {},
    })).toEqual({
      map: {1: 'one', k: ['2']},
      missing: {type: 'undefined'},
      fn: '[Function named]',
    })
  })
})
