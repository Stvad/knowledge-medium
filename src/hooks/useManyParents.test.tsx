// @vitest-environment happy-dom
/**
 * `useManyParents` carry-over, at the seam the panel tests can't reach.
 *
 * The panel-level repro (`plugins/backlinks/test/linkedReferencesRefresh`)
 * covers the happy path over a real repo. What it can't stage is a
 * `core.manyAncestors` load that FAILS: that leaves `peek()` undefined
 * permanently — `LoaderHandle` rolls its deps back on error so nothing
 * can invalidate it, and `useHandle` only ensure-loads from 'idle' — so
 * carrying the previous chains there would pin stale breadcrumbs for the
 * rest of the session rather than for one load.
 */

import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { Handle, HandleStatus } from '@/data/api'
import type { Block } from '@/data/block'
import { useManyParents } from './block.ts'

interface AncestorsEntry {
  startId: string
  ancestors: {id: string}[]
}

const mocks = vi.hoisted(() => ({
  repo: undefined as unknown,
}))

vi.mock('@/context/repo.tsx', () => ({
  useRepo: () => mocks.repo,
}))

/** A `core.manyAncestors` stand-in whose value and status the test drives. */
const fakeHandle = (
  value: AncestorsEntry[] | undefined,
  status: HandleStatus,
): Handle<AncestorsEntry[]> => ({
  key: `many-ancestors:${value?.map(e => e.startId).join(',') ?? 'none'}`,
  peek: () => value,
  load: () => status === 'error'
    ? Promise.reject(new Error('load failed'))
    : Promise.resolve(value ?? []),
  subscribe: () => () => {},
  read: () => value ?? [],
  status: () => status,
})

const setupRepo = (handleFor: (ids: readonly string[]) => Handle<AncestorsEntry[]>) => {
  mocks.repo = {
    block: (id: string) => ({id}) as Block,
    query: {manyAncestors: ({ids}: {ids: readonly string[]}) => handleFor(ids)},
  }
}

const blocksFor = (ids: string[]) => ids.map(id => ({id}) as Block)

const chainsFor = (ids: string[]): AncestorsEntry[] =>
  ids.map(id => ({startId: id, ancestors: [{id: `${id}-parent`}]}))

describe('useManyParents', () => {
  it('carries the previous chains while a re-keyed handle is still loading', () => {
    setupRepo(ids => ids.length === 2
      ? fakeHandle(chainsFor(['a', 'b']), 'ready')
      : fakeHandle(undefined, 'loading'))

    const {result, rerender} = renderHook(
      ({ids}: {ids: string[]}) => useManyParents(blocksFor(ids)),
      {initialProps: {ids: ['a', 'b']}},
    )
    expect(result.current.get('a')?.map(p => p.id)).toEqual(['a-parent'])

    rerender({ids: ['a', 'b', 'c']})

    expect(result.current.get('a')?.map(p => p.id)).toEqual(['a-parent'])
    expect(result.current.get('b')?.map(p => p.id)).toEqual(['b-parent'])
    // An id entering the set has nothing to carry — documented residual.
    expect(result.current.has('c')).toBe(false)
  })

  it('drops the carried chains when the re-keyed load failed', () => {
    setupRepo(ids => ids.length === 2
      ? fakeHandle(chainsFor(['a', 'b']), 'ready')
      : fakeHandle(undefined, 'error'))

    const {result, rerender} = renderHook(
      ({ids}: {ids: string[]}) => useManyParents(blocksFor(ids)),
      {initialProps: {ids: ['a', 'b']}},
    )
    expect(result.current.get('a')?.map(p => p.id)).toEqual(['a-parent'])

    rerender({ids: ['a', 'b', 'c']})

    // Not carried: an errored handle never retries and never invalidates,
    // so these breadcrumbs would never correct themselves.
    expect(result.current.size).toBe(0)
  })
})
