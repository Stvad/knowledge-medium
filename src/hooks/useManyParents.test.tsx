// @vitest-environment happy-dom
/**
 * `useManyParents` carry-over at the hook seam. The panel repro
 * (`plugins/backlinks/test/linkedReferencesRefresh`) covers what the
 * user sees; this pins what it can't reach.
 *
 * The fake handle deliberately mints a NEW object per lookup, unlike
 * the real store's same-key-same-instance guarantee. That is the point:
 * it reproduces the equal-but-fresh-map churn that the hook's
 * structural check exists to terminate — drop that check and this file
 * dies with "Too many re-renders".
 */

import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { Handle } from '@/data/api'
import type { Block } from '@/data/block'
import { useManyParents } from './block.ts'

interface AncestorsEntry {
  startId: string
  ancestors: {id: string}[]
}

const chainsFor = (ids: readonly string[]): AncestorsEntry[] =>
  ids.map(id => ({startId: id, ancestors: [{id: `${id}-parent`}]}))

/** `useHandle` reaches `peek()`, `status()` and `subscribe()`; it calls
 *  `load()` only from `'idle'`, and never `read()` or `key`. */
const fakeHandle = (value: AncestorsEntry[] | undefined): Handle<AncestorsEntry[]> => ({
  key: 'many-ancestors',
  peek: () => value,
  load: () => Promise.resolve(value ?? []),
  subscribe: () => () => {},
  read: () => value ?? [],
  status: () => value ? 'ready' : 'loading',
})

/** Resolves for `['a','b']` and for the empty set; anything else is
 *  still loading — i.e. every other key is freshly cold. */
const repo = {
  block: (id: string) => ({id}) as Block,
  query: {
    manyAncestors: ({ids}: {ids: readonly string[]}) => fakeHandle(
      ids.length === 0 || (ids.length === 2 && ids[0] === 'a')
        ? chainsFor(ids)
        : undefined,
    ),
  },
}

vi.mock('@/context/repo.tsx', () => ({useRepo: () => repo}))

const blocksFor = (ids: string[]) => ids.map(id => ({id}) as Block)

const renderWith = (ids: string[]) => renderHook(
  ({blocks}: {blocks: Block[]}) => useManyParents(blocks),
  {initialProps: {blocks: blocksFor(ids)}},
)

describe('useManyParents', () => {
  it('carries the resolved chains while a re-keyed handle is still loading', () => {
    const {result, rerender} = renderWith(['a', 'b'])
    expect(result.current.get('a')?.map(p => p.id)).toEqual(['a-parent'])

    rerender({blocks: blocksFor(['a', 'b', 'c'])})

    expect(result.current.get('a')?.map(p => p.id)).toEqual(['a-parent'])
    expect(result.current.get('b')?.map(p => p.id)).toEqual(['b-parent'])
    // An id ENTERING the set has nothing to carry — the documented
    // residual: that entry gains its breadcrumb line a load late.
    expect(result.current.has('c')).toBe(false)
  })

  it('survives an empty id set passing through', () => {
    // A list handle that re-keys (turning a backlinks filter on) reports
    // `[]` for a beat. That resolves trivially, and remembering it would
    // wipe the chains the very next render needs.
    const {result, rerender} = renderWith(['a', 'b'])

    rerender({blocks: []})
    rerender({blocks: blocksFor(['a'])})

    expect(result.current.get('a')?.map(p => p.id)).toEqual(['a-parent'])
  })
})
