import { describe, expect, it, vi } from 'vitest'
import { mapSettled } from './scan.js'

describe('mapSettled', () => {
  it('maps each item, preserving order', async () => {
    expect(await mapSettled([1, 2, 3], async (n) => n * 2, () => -1)).toEqual([2, 4, 6])
  })

  it('isolates a per-item failure via onError without aborting the rest', async () => {
    const result = await mapSettled(
      [1, 2, 3],
      async (n) => {
        if (n === 2) throw new Error('boom')
        return n
      },
      (item) => 1000 + item,
    )
    expect(result).toEqual([1, 1002, 3])
  })

  it('passes the offending item and error to onError', async () => {
    const onError = vi.fn(() => 'fallback')
    const err = new Error('torn stream')
    await mapSettled(
      ['a'],
      async () => {
        throw err
      },
      onError,
    )
    expect(onError).toHaveBeenCalledWith('a', err)
  })
})
