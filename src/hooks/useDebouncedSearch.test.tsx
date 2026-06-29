// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDebouncedSearch, type DebouncedSearchOptions } from './useDebouncedSearch.ts'

const DELAY = 80

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

const setup = (props: Partial<DebouncedSearchOptions<string>> & { query: string; search: DebouncedSearchOptions<string>['search'] }) =>
  renderHook(
    (p: DebouncedSearchOptions<string>) => useDebouncedSearch(p),
    { initialProps: { delayMs: DELAY, ...props } as DebouncedSearchOptions<string> },
  )

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('useDebouncedSearch', () => {
  it('fires the search only after the debounce settles, not per keystroke', async () => {
    const d = deferred<string[]>()
    const search = vi.fn(() => d.promise)
    const { result, rerender } = setup({ query: '', search })

    rerender({ query: 'a', delayMs: DELAY, search })
    expect(search).not.toHaveBeenCalled() // debounce pending

    await act(async () => { await vi.advanceTimersByTimeAsync(DELAY) })
    expect(search).toHaveBeenCalledTimes(1)
    expect(search).toHaveBeenCalledWith('a')

    await act(async () => { d.resolve(['A1']); await d.promise })
    expect(result.current.results).toEqual(['A1'])
  })

  it('does not search when disabled or when the query is empty', async () => {
    const search = vi.fn(() => Promise.resolve<string[]>([]))
    const { rerender } = setup({ query: 'a', enabled: false, search })
    await act(async () => { await vi.advanceTimersByTimeAsync(DELAY) })
    expect(search).not.toHaveBeenCalled() // disabled

    rerender({ query: '   ', delayMs: DELAY, enabled: true, search })
    await act(async () => { await vi.advanceTimersByTimeAsync(DELAY) })
    expect(search).not.toHaveBeenCalled() // whitespace-only trims to empty
  })

  it('cancels an in-flight search so a late stale result never lands', async () => {
    const d1 = deferred<string[]>()
    const d2 = deferred<string[]>()
    const search = vi.fn<DebouncedSearchOptions<string>['search']>()
      .mockReturnValueOnce(d1.promise)
      .mockReturnValueOnce(d2.promise)
    const { result, rerender } = setup({ query: '', search })

    rerender({ query: 'a', delayMs: DELAY, search })
    await act(async () => { await vi.advanceTimersByTimeAsync(DELAY) }) // fires search('a') → d1
    expect(search).toHaveBeenLastCalledWith('a')

    rerender({ query: 'ab', delayMs: DELAY, search }) // keystroke cancels the in-flight 'a' search
    await act(async () => { await vi.advanceTimersByTimeAsync(DELAY) }) // settles → search('ab') → d2
    expect(search).toHaveBeenLastCalledWith('ab')

    // Resolve the FRESH 'ab' request first, then the stale 'a' one LAST — the
    // dangerous interleaving (a slow previous request finishing after the new
    // one). Cancellation, not resolve order, must keep the 'ab' results.
    await act(async () => {
      d2.resolve(['AB']); await d2.promise
      d1.resolve(['STALE-A']); await d1.promise
    })
    expect(result.current.results).toEqual(['AB'])
    expect(result.current.resultsQuery).toBe('ab')
  })

  it('reset() drops an in-flight search so a late result cannot repopulate', async () => {
    const d = deferred<string[]>()
    const search = vi.fn(() => d.promise)
    const { result, rerender } = setup({ query: '', search })
    rerender({ query: 'a', delayMs: DELAY, search })
    await act(async () => { await vi.advanceTimersByTimeAsync(DELAY) }) // fires search('a') → d (pending)

    act(() => result.current.reset())
    // The in-flight 'a' resolves AFTER reset — it must not land (reset cancels
    // it on its own, without the caller also having to change the query).
    await act(async () => { d.resolve(['A']); await d.promise })
    expect(result.current.results).toEqual([])
    expect(result.current.resultsQuery).toBe('')
  })

  it('re-runs the search when a revalidateOn dep changes', async () => {
    const search = vi.fn(() => Promise.resolve(['R']))
    const exclude1 = new Set(['x'])
    const exclude2 = new Set(['x', 'y'])
    const { rerender } = setup({ query: 'a', search, revalidateOn: [exclude1] })
    await act(async () => { await vi.advanceTimersByTimeAsync(DELAY) })
    expect(search).toHaveBeenCalledTimes(1)

    rerender({ query: 'a', delayMs: DELAY, search, revalidateOn: [exclude2] })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(search).toHaveBeenCalledTimes(2) // settled query, exclude-set changed → re-search
  })

  it('reset() clears results', async () => {
    const search = vi.fn(() => Promise.resolve(['A']))
    const { result, rerender } = setup({ query: 'a', search })
    rerender({ query: 'a', delayMs: DELAY, search })
    await act(async () => { await vi.advanceTimersByTimeAsync(DELAY) })
    expect(result.current.results).toEqual(['A'])

    act(() => result.current.reset())
    expect(result.current.results).toEqual([])
  })

  it('tracks the query its results were fetched for and clears it on reset', async () => {
    const search = vi.fn(() => Promise.resolve(['A']))
    const { result, rerender } = setup({ query: 'a', search })
    rerender({ query: 'a', delayMs: DELAY, search })
    await act(async () => { await vi.advanceTimersByTimeAsync(DELAY) })
    expect(result.current.resultsQuery).toBe('a')

    act(() => result.current.reset())
    expect(result.current.resultsQuery).toBe('')
  })

  it('leaves resultsQuery on the previous query until the new search resolves (staleness signal)', async () => {
    const d1 = deferred<string[]>()
    const d2 = deferred<string[]>()
    const search = vi.fn<DebouncedSearchOptions<string>['search']>()
      .mockReturnValueOnce(d1.promise)
      .mockReturnValueOnce(d2.promise)
    const { result, rerender } = setup({ query: '', search })

    rerender({ query: 'a', delayMs: DELAY, search })
    await act(async () => { await vi.advanceTimersByTimeAsync(DELAY) })
    await act(async () => { d1.resolve(['A']); await d1.promise })
    expect(result.current.resultsQuery).toBe('a')

    // Type ahead to 'ab'. Until the new search resolves, resultsQuery stays 'a'
    // — so a consumer comparing it to the live trimmed text ('ab') can tell the
    // results are stale and decline to commit one of them.
    rerender({ query: 'ab', delayMs: DELAY, search })
    await act(async () => { await vi.advanceTimersByTimeAsync(DELAY) })
    expect(result.current.resultsQuery).toBe('a')

    await act(async () => { d2.resolve(['AB']); await d2.promise })
    expect(result.current.resultsQuery).toBe('ab')
  })

  it('does NOT refetch-loop when a fresh search closure is passed every render', async () => {
    // The footgun: if `search` were an effect dependency, a new closure each
    // render (the un-memoized / compiler-bailout case) would re-run the effect,
    // and since each resolved search sets a new `results` array that would loop
    // forever. The latest-ref pattern must make identity irrelevant.
    let calls = 0
    const { result, rerender } = renderHook(
      ({ query }: { query: string }) =>
        useDebouncedSearch<string>({
          query,
          delayMs: DELAY,
          // brand-new closure on EVERY render (incl. the setResults re-render)
          search: () => { calls += 1; return Promise.resolve(['X']) },
        }),
      { initialProps: { query: 'a' } },
    )

    await act(async () => { await vi.advanceTimersByTimeAsync(DELAY) })
    // Let any errant loop have several ticks to manifest.
    await act(async () => { await vi.advanceTimersByTimeAsync(DELAY * 3) })
    expect(calls).toBe(1)
    expect(result.current.results).toEqual(['X'])

    // Extra renders with a settled, unchanged query must not re-search either.
    rerender({ query: 'a' })
    rerender({ query: 'a' })
    await act(async () => { await vi.advanceTimersByTimeAsync(DELAY) })
    expect(calls).toBe(1)
  })
})
