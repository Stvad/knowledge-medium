import { describe, expect, it } from 'vitest'
import { memoizeAsync } from '@/utils/memoize'

describe('memoizeAsync', () => {
  it('evicts a rejected entry so the next call retries', async () => {
    let calls = 0
    const fn = memoizeAsync(async (key: string) => {
      calls++
      if (calls === 1) throw new Error(`first ${key}`)
      return key
    }, key => key)
    await expect(fn('a')).rejects.toThrow('first a')
    expect(await fn('a')).toBe('a')
    expect(calls).toBe(2)
  })

  it('with maxEntries drops the oldest entry once the bound is passed', async () => {
    let calls = 0
    const fn = memoizeAsync(async (key: string) => { calls++; return key }, key => key, 2)
    await fn('a')
    await fn('b')
    await fn('a') // a hit: still cached
    await fn('c') // pushes 'a' out
    await fn('a')
    expect(calls).toBe(4)
  })
})
