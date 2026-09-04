// @vitest-environment node
/**
 * `memoizeAsync` — the difference from `memoize` that the state-block ensures
 * depend on.
 *
 * A rejected promise is a perfectly good cache entry, so plain `memoize` hands
 * one transient failure to every later caller for the life of the page. The
 * `ensure` helpers built on this are all retried by their callers, which is
 * exactly the assumption a cached rejection breaks.
 */
import { describe, expect, it, vi } from 'vitest'
import { memoizeAsync } from '../memoize'

describe('memoizeAsync', () => {
  it('memoizes a result, like memoize', async () => {
    const fn = vi.fn(async (key: string) => `${key}!`)
    const memoized = memoizeAsync(fn, (key) => key)

    expect(await memoized('a')).toBe('a!')
    expect(await memoized('a')).toBe('a!')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  // These ensures are passed straight to React `use()`, which requires the same
  // promise across renders — a fresh wrapper per call re-suspends forever. What
  // is cached has to be the promise callers actually receive.
  it('returns the same promise object for the same key', () => {
    const memoized = memoizeAsync(async (key: string) => key, (key) => key)

    expect(memoized('a')).toBe(memoized('a'))
    expect(memoized('a')).not.toBe(memoized('b'))
  })

  it('retries after a rejection instead of caching it', async () => {
    let attempt = 0
    const fn = vi.fn(async (key: string) => {
      if (++attempt === 1) throw new Error('transient')
      return `${key}!`
    })
    const memoized = memoizeAsync(fn, (key) => key)

    await expect(memoized('a')).rejects.toThrow('transient')
    expect(await memoized('a')).toBe('a!')
  })

  it('keeps entries for other keys when one rejects', async () => {
    const fn = vi.fn(async (key: string) => {
      if (key === 'bad') throw new Error('nope')
      return key
    })
    const memoized = memoizeAsync(fn, (key) => key)

    expect(await memoized('good')).toBe('good')
    await expect(memoized('bad')).rejects.toThrow('nope')
    expect(await memoized('good')).toBe('good')
    // 'good' still answered from the cache — the eviction took only its own key.
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
