// @vitest-environment happy-dom
//
// The contract here is about WHEN and HOW OFTEN ancestors are fetched, not
// about what a crumb reads (`utils/test/blockCrumbs.test.ts` owns that):
// the whole feature is only acceptable if it costs one batched query for a
// page of results, doesn't re-fetch what it already has as the user keeps
// typing, and can't take the search down when it fails.

import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BlockData } from '@/data/api'

interface AncestorEntry { startId: string; ancestors: BlockData[] }

const manyAncestors = vi.fn<(args: {ids: readonly string[]}) => Promise<AncestorEntry[]>>()

vi.mock('@/context/repo.js', () => ({
  useRepo: () => ({
    query: {
      manyAncestors: (args: {ids: readonly string[]}) => ({
        load: () => manyAncestors(args),
      }),
    },
  }),
}))

const { useAncestorCrumbs } = await import('./useAncestorCrumbs.js')

const ancestorRow = (id: string, content: string): BlockData => ({
  id,
  content,
  properties: {},
  workspaceId: 'ws-1',
  parentId: null,
  orderKey: 'a0',
  updatedAt: 0,
  userUpdatedAt: 0,
  updatedBy: 'u1',
  deleted: false,
} as unknown as BlockData)

/** One crumb per id, named after it, so a mixed-up mapping is visible in
 *  the assertion rather than hidden behind a matching count. */
const chainFor = (id: string): AncestorEntry => ({
  startId: id,
  ancestors: [ancestorRow(`${id}-parent`, `${id} parent`)],
})

const idsOf = (call: [{ids: readonly string[]}]) => [...call[0].ids]

beforeEach(() => {
  manyAncestors.mockReset()
  manyAncestors.mockImplementation(async ({ids}) => ids.map(chainFor))
})

afterEach(() => vi.restoreAllMocks())

describe('useAncestorCrumbs', () => {
  it('fetches a whole page of results in ONE batched query', async () => {
    const ids = Array.from({length: 25}, (_, i) => `block-${i}`)

    const {result} = renderHook(() => useAncestorCrumbs(ids))

    await waitFor(() => expect(result.current.size).toBe(25))
    expect(manyAncestors).toHaveBeenCalledOnce()
    expect(idsOf(manyAncestors.mock.calls[0])).toEqual(ids)
  })

  it('maps each chain onto the block it belongs to', async () => {
    const {result} = renderHook(() => useAncestorCrumbs(['a', 'b']))

    await waitFor(() => expect(result.current.size).toBe(2))
    expect(result.current.get('a')).toEqual(['a parent'])
    expect(result.current.get('b')).toEqual(['b parent'])
  })

  it('hands back a usable empty map while the load is still in flight', async () => {
    // Search rows paint first; the crumb map is simply empty until the
    // second pass lands. A hook that suspended or threw here would put the
    // ancestor query in front of the results. The release half is what
    // makes the empty assertion mean something — it proves the map was
    // pending, not permanently dead.
    let release: (entries: AncestorEntry[]) => void = () => {}
    manyAncestors.mockReturnValueOnce(new Promise(resolve => { release = resolve }))

    const {result} = renderHook(() => useAncestorCrumbs(['a']))

    expect(result.current.size).toBe(0)

    release([chainFor('a')])
    await waitFor(() => expect(result.current.get('a')).toEqual(['a parent']))
  })

  it('only queries the ids it has not already loaded as the query changes', async () => {
    const {result, rerender} = renderHook(
      ({ids}: {ids: string[]}) => useAncestorCrumbs(ids),
      {initialProps: {ids: ['a', 'b']}},
    )
    await waitFor(() => expect(result.current.size).toBe(2))

    // Next keystroke: 'b' survived, 'c' is new.
    rerender({ids: ['b', 'c']})
    await waitFor(() => expect(result.current.size).toBe(3))

    expect(manyAncestors).toHaveBeenCalledTimes(2)
    expect(idsOf(manyAncestors.mock.calls[1])).toEqual(['c'])
    // 'b' keeps its crumbs across the re-query rather than blanking.
    expect(result.current.get('b')).toEqual(['b parent'])
  })

  it('keeps a superseded run\u2019s result instead of throwing it away', async () => {
    // The ancestors of a block do not depend on the search query that
    // prompted the lookup, so a result that arrives "late" is still the
    // right answer. Dropping it would only mean asking again.
    let releaseFirst: (entries: AncestorEntry[]) => void = () => {}
    manyAncestors.mockImplementationOnce(
      () => new Promise<AncestorEntry[]>(resolve => { releaseFirst = resolve }),
    )

    const {result, rerender} = renderHook(
      ({ids}: {ids: string[]}) => useAncestorCrumbs(ids),
      {initialProps: {ids: ['a']}},
    )
    await waitFor(() => expect(manyAncestors).toHaveBeenCalledOnce())

    rerender({ids: ['a', 'b']})
    await waitFor(() => expect(manyAncestors).toHaveBeenCalledTimes(2))
    // 'a' was already in flight, so the second run asked only for what
    // nobody was fetching yet.
    expect(idsOf(manyAncestors.mock.calls[1])).toEqual(['b'])

    releaseFirst([chainFor('a')])
    await waitFor(() => expect(result.current.get('a')).toEqual(['a parent']))
    expect(result.current.get('b')).toEqual(['b parent'])
  })

  it('survives the id list transiently emptying between queries', async () => {
    // This is the caller's real shape: the rows are gated on the search
    // result matching the LIVE query, so the id list drops to [] the
    // instant a key is pressed and refills once the search resolves. If
    // that teardown cancelled work, every keystroke would re-fetch what
    // was already on its way.
    let release: (entries: AncestorEntry[]) => void = () => {}
    manyAncestors.mockImplementationOnce(
      () => new Promise<AncestorEntry[]>(resolve => { release = resolve }),
    )

    const {result, rerender} = renderHook(
      ({ids}: {ids: string[]}) => useAncestorCrumbs(ids),
      {initialProps: {ids: ['a', 'b']}},
    )
    await waitFor(() => expect(manyAncestors).toHaveBeenCalledOnce())

    rerender({ids: []})
    rerender({ids: ['a', 'b', 'c']})
    await waitFor(() => expect(manyAncestors).toHaveBeenCalledTimes(2))
    expect(idsOf(manyAncestors.mock.calls[1])).toEqual(['c'])

    release([chainFor('a'), chainFor('b')])
    await waitFor(() => expect(result.current.get('a')).toEqual(['a parent']))
    expect(result.current.get('b')).toEqual(['b parent'])
  })

  it('logs and drops a failed load instead of surfacing it', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    manyAncestors.mockRejectedValueOnce(new Error('ancestors exploded'))

    const {result, rerender} = renderHook(
      ({ids}: {ids: string[]}) => useAncestorCrumbs(ids),
      {initialProps: {ids: ['a']}},
    )

    await waitFor(() => expect(consoleError).toHaveBeenCalled())
    expect(result.current.size).toBe(0)

    // The failed ids stay eligible, so the next query retries them.
    rerender({ids: ['a', 'b']})
    await waitFor(() => expect(result.current.get('a')).toEqual(['a parent']))
  })
})
