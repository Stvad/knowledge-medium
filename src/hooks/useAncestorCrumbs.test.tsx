// @vitest-environment happy-dom
//
// The contract here is about WHICH handles the hook holds and what it
// does with their values, not about what a crumb reads
// (`utils/test/blockCrumbs.test.ts` owns that) and not about how many SQL
// statements the walks cost (`data/internals/ancestorBatch.test.ts` owns
// that): the feature is only acceptable if it doesn't re-ask for what it
// already has as the user keeps typing, and can't take the search down
// when it fails.

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BlockData, Handle, HandleStatus } from '@/data/api'

/** A handle the test drives: it starts `'idle'`, `load()` hands it to the
 *  file-level resolver for its key, and `settle` publishes to subscribers
 *  the way a `LoaderHandle` does. */
class FakeHandle<T> implements Handle<T> {
  private value: T | undefined
  private state: HandleStatus = 'idle'
  private readonly listeners = new Set<(value: T) => void>()

  constructor(readonly key: string, private readonly resolve: () => Promise<T>) {}

  peek(): T | undefined { return this.value }
  status(): HandleStatus { return this.state }
  read(): T { return this.value as T }
  subscribe(listener: (value: T) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async load(): Promise<T> {
    this.state = 'loading'
    try {
      const next = await this.resolve()
      this.settle(next)
      return next
    } catch (error) {
      this.state = 'error'
      throw error
    }
  }

  settle(next: T): void {
    this.value = next
    this.state = 'ready'
    act(() => { for (const listener of this.listeners) listener(next) })
  }
}

const row = (id: string, content: string, parentId: string | null): BlockData => ({
  id,
  content,
  properties: {},
  workspaceId: 'ws-1',
  parentId,
  orderKey: 'a0',
  updatedAt: 0,
  userUpdatedAt: 0,
  updatedBy: 'u1',
  deleted: false,
} as unknown as BlockData)

/** One crumb per id, named after it, so a mixed-up mapping is visible in
 *  the assertion rather than hidden behind a matching count. */
const chainFor = (id: string): BlockData[] => [row(`${id}-parent`, `${id} parent`, null)]

const ancestorHandles = new Map<string, FakeHandle<BlockData[]>>()
const blockHandles = new Map<string, FakeHandle<BlockData | null>>()
/** Every `repo.query.ancestors({id})` lookup, in order — how the test
 *  sees which ids the hook actually asked about. */
const acquired: string[] = []
/** Per-id overrides for the next `load()`; absent means the default chain. */
const chainResolvers = new Map<string, () => Promise<BlockData[]>>()
/** Ids whose row is loaded in the cache. Absent means `peek()` is
 *  undefined — a row the search returned but nothing has hydrated. */
const loadedRows = new Map<string, string | null>()

// One stable repo object, deliberately — `useRepo` is memoized for the
// app's lifetime in production (`src/context/repo.tsx`), and `repo` is a
// memo dependency here. A mock returning a fresh literal per render would
// rebuild the handle arrays every render, which quietly turns "the hook
// re-asked" into "the harness did".
const repo = {
  activeWorkspaceId: 'ws-1' as string | null,
  block: (id: string) => {
    let handle = blockHandles.get(id)
    if (!handle) {
      handle = new FakeHandle<BlockData | null>(`block:${id}`, async () =>
        loadedRows.has(id) ? row(id, id, loadedRows.get(id) ?? null) : null)
      blockHandles.set(id, handle)
    }
    return handle
  },
  query: {
    ancestors: ({id}: {id: string}) => {
      acquired.push(id)
      let handle = ancestorHandles.get(id)
      if (!handle) {
        handle = new FakeHandle<BlockData[]>(
          `ancestors:${id}`,
          () => (chainResolvers.get(id) ?? (async () => chainFor(id)))(),
        )
        ancestorHandles.set(id, handle)
      }
      return handle
    },
  },
}

vi.mock('@/context/repo.js', () => ({useRepo: () => repo}))

const { useAncestorCrumbs } = await import('./useAncestorCrumbs.js')

/** Blocks that genuinely have a parent — matching `chainFor`, which gives
 *  each one a parent row. The hook needs the parent edge to tell a root
 *  from an orphan when the ancestor walk comes back empty. */
const targets = (...ids: string[]) => ids.map(id => ({id, parentId: `${id}-parent`}))

beforeEach(() => {
  ancestorHandles.clear()
  blockHandles.clear()
  chainResolvers.clear()
  loadedRows.clear()
  acquired.length = 0
})

afterEach(() => vi.restoreAllMocks())

describe('useAncestorCrumbs', () => {
  it('maps each chain onto the block it belongs to', async () => {
    const {result} = renderHook(() => useAncestorCrumbs(targets('a', 'b')))

    await waitFor(() => expect(result.current.size).toBe(2))
    expect(result.current.get('a')).toEqual(['a parent'])
    expect(result.current.get('b')).toEqual(['b parent'])
  })

  it('hands back a usable empty map while the walk is still in flight', async () => {
    // Search rows paint first; the crumb map is simply empty until the
    // walks land. A hook that suspended or threw here would put the
    // ancestor query in front of the results. The release half is what
    // makes the empty assertion mean something — it proves the map was
    // pending, not permanently dead.
    let release: (chain: BlockData[]) => void = () => {}
    chainResolvers.set('a', () => new Promise(resolve => { release = resolve }))

    const {result} = renderHook(() => useAncestorCrumbs(targets('a')))

    expect(result.current.size).toBe(0)

    release(chainFor('a'))
    await waitFor(() => expect(result.current.get('a')).toEqual(['a parent']))
  })

  it('asks only about the ids that entered as the result set shifts', async () => {
    const {result, rerender} = renderHook(
      ({ids}: {ids: string[]}) => useAncestorCrumbs(targets(...ids)),
      {initialProps: {ids: ['a', 'b']}},
    )
    await waitFor(() => expect(result.current.size).toBe(2))
    acquired.length = 0

    // Next keystroke: 'b' survived, 'c' is new.
    rerender({ids: ['b', 'c']})
    await waitFor(() => expect(result.current.size).toBe(2))

    expect(new Set(acquired)).toEqual(new Set(['b', 'c']))
    // 'b' keeps its crumbs across the shift rather than blanking — its
    // handle resolved once and nothing about it changed.
    expect(result.current.get('b')).toEqual(['b parent'])
    expect(result.current.get('c')).toEqual(['c parent'])
  })

  it('survives the id list transiently emptying between queries', async () => {
    // This is the caller's real shape: the rows are gated on the search
    // result matching the LIVE query, so the id list drops to [] the
    // instant a key is pressed and refills once the search resolves. If
    // that teardown threw the resolved chains away, every keystroke would
    // re-fetch what it already had.
    const {result, rerender} = renderHook(
      ({ids}: {ids: string[]}) => useAncestorCrumbs(targets(...ids)),
      {initialProps: {ids: ['a', 'b']}},
    )
    await waitFor(() => expect(result.current.size).toBe(2))

    rerender({ids: []})
    expect(result.current.size).toBe(0)

    rerender({ids: ['a', 'b', 'c']})
    await waitFor(() => expect(result.current.size).toBe(3))
    expect(result.current.get('a')).toEqual(['a parent'])
    expect(result.current.get('b')).toEqual(['b parent'])
  })

  it('re-crumbs a block reparented while the dialog is open', async () => {
    // What the snapshot shape could not do. The walk is row-dep'd, so a
    // move invalidates it and the crumb follows the block.
    const {result} = renderHook(() => useAncestorCrumbs(targets('a')))
    await waitFor(() => expect(result.current.get('a')).toEqual(['a parent']))

    ancestorHandles.get('a')!.settle([row('moved', 'somewhere else', null)])

    await waitFor(() => expect(result.current.get('a')).toEqual(['somewhere else']))
  })

  it('leaves a failed walk absent instead of surfacing the error', async () => {
    // Breadcrumbs are decoration: a failure costs one missing crumb line,
    // never the search dialog.
    chainResolvers.set('a', () => Promise.reject(new Error('ancestors exploded')))

    const {result} = renderHook(() => useAncestorCrumbs(targets('a', 'b')))

    await waitFor(() => expect(result.current.get('b')).toEqual(['b parent']))
    expect(result.current.has('a')).toBe(false)
  })

  it('retries a failed walk when the result set next changes', async () => {
    // One failed read errors every id it coalesced, so a single hiccup
    // can strand a whole page of crumbs. A first-load failure leaves the
    // handle with no deps, so nothing invalidates it into a retry — the
    // next keystroke arriving as an observer is the only retry it gets.
    let attempts = 0
    chainResolvers.set('a', () => {
      attempts += 1
      return attempts === 1
        ? Promise.reject(new Error('read failed'))
        : Promise.resolve(chainFor('a'))
    })

    const {result, rerender} = renderHook(
      ({ids}: {ids: string[]}) => useAncestorCrumbs(targets(...ids)),
      {initialProps: {ids: ['a']}},
    )
    await waitFor(() => expect(attempts).toBe(1))
    expect(result.current.has('a')).toBe(false)

    rerender({ids: ['a', 'b']})

    await waitFor(() => expect(result.current.get('a')).toEqual(['a parent']))
  })

  it('prefers the live row over the search payload for the seed parent', async () => {
    // `core.searchByContent` declares no row deps, so a parent move on a
    // result row does NOT invalidate it — the payload can still claim a
    // parent for a block that has since moved to the workspace root, while
    // the ancestor walk (which IS row-dep'd) correctly returns nothing.
    // Trusting the payload there would mark a genuine root as truncated.
    loadedRows.set('a', null)
    chainResolvers.set('a', async () => [])

    const {result} = renderHook(() => useAncestorCrumbs([{id: 'a', parentId: 'stale-parent'}]))

    await waitFor(() => expect(result.current.get('a')).toEqual([]))
  })

  it('falls back to the search payload when the row is not loaded', async () => {
    chainResolvers.set('a', async () => [])

    const {result} = renderHook(() => useAncestorCrumbs([{id: 'a', parentId: 'gone-parent'}]))

    await waitFor(() => expect(result.current.get('a')).toEqual(['…']))
  })

  it('round-trips ids that contain the serialization delimiters', async () => {
    // `blockId.ts` enforces canonical uuids on the tx INSERT path only, and
    // exempts sync-applied and applyRaw rows — so an id carrying a comma
    // cannot be ruled out, and splitting on one would query the wrong ids.
    const awkward = 'weird,id>with:delimiters'

    const {result} = renderHook(() => useAncestorCrumbs([{id: awkward, parentId: null}]))

    // The id reaches the query intact and its crumbs come back keyed by it
    // (the label itself is truncated, which is beside the point here).
    await waitFor(() => expect(result.current.has(awkward)).toBe(true))
    expect(acquired).toEqual([awkward])
  })

  it('asks for nothing when there is no active workspace', async () => {
    // Crumbs are workspace-scoped, and with no workspace there is nothing
    // to scope an ancestor against — so the hook declines to look rather
    // than fetching rows it could not safely render.
    repo.activeWorkspaceId = null
    try {
      const {result} = renderHook(() => useAncestorCrumbs(targets('a')))

      await waitFor(() => expect(result.current.size).toBe(0))
      expect(acquired).toEqual([])
    } finally {
      repo.activeWorkspaceId = 'ws-1'
    }

    // Fences the assertion above on a real lookup happening once the
    // workspace IS known, so it can't pass just because nothing resolved.
    const {result: withWorkspace} = renderHook(() => useAncestorCrumbs(targets('a')))
    await waitFor(() => expect(withWorkspace.current.get('a')).toEqual(['a parent']))
  })
})
