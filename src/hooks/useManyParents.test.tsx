// @vitest-environment happy-dom
/**
 * `useManyParents` carry-over at the hook seam. The panel repro
 * (`plugins/backlinks/test/linkedReferencesRefresh`) covers what the
 * user sees; this pins the two properties it doesn't reach.
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

const mocks = vi.hoisted(() => ({repo: undefined as unknown}))

vi.mock('@/context/repo.tsx', () => ({
  useRepo: () => mocks.repo,
}))

/** Only `peek()` and `status()` are reached: `useHandle` calls `load()`
 *  solely from `'idle'`, and `read()`/`key` not at all. */
const fakeHandle = (value: AncestorsEntry[] | undefined): Handle<AncestorsEntry[]> => ({
  key: 'many-ancestors',
  peek: () => value,
  load: () => Promise.resolve(value ?? []),
  subscribe: () => () => {},
  read: () => value ?? [],
  status: () => value ? 'ready' : 'loading',
})

const chainsFor = (ids: string[]): AncestorsEntry[] =>
  ids.map(id => ({startId: id, ancestors: [{id: `${id}-parent`}]}))

/** `a` and `b` resolve; any other id set is still loading. */
const setupRepo = () => {
  mocks.repo = {
    block: (id: string) => ({id}) as Block,
    query: {
      manyAncestors: ({ids}: {ids: readonly string[]}) =>
        fakeHandle(ids.length === 2 ? chainsFor(['a', 'b']) : undefined),
    },
  }
}

const blocksFor = (ids: string[]) => ids.map(id => ({id}) as Block)

describe('useManyParents', () => {
  it('carries the resolved chains while a re-keyed handle is still loading', () => {
    setupRepo()
    const {result, rerender} = renderHook(
      ({blocks}: {blocks: Block[]}) => useManyParents(blocks),
      {initialProps: {blocks: blocksFor(['a', 'b'])}},
    )
    expect(result.current.get('a')?.map(p => p.id)).toEqual(['a-parent'])

    rerender({blocks: blocksFor(['a', 'b', 'c'])})

    expect(result.current.get('a')?.map(p => p.id)).toEqual(['a-parent'])
    expect(result.current.get('b')?.map(p => p.id)).toEqual(['b-parent'])
    // An id ENTERING the set has nothing to carry — the documented
    // residual: that entry gains its breadcrumb line a load late.
    expect(result.current.has('c')).toBe(false)
  })
})
