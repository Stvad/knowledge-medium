// @vitest-environment happy-dom
/**
 * `useManyParents` at the hook seam. The panel repro
 * (`plugins/backlinks/test/linkedReferencesRefresh`) covers what the
 * user sees; this pins the properties that make it work — that a
 * change to the id SET queries only the ids that entered, and that
 * every other id's chain is still there in the same render.
 *
 * The repo below is a fake, and deliberately so: what is under test is
 * which handles the hook acquires and what it does with their peeks,
 * and a fake is the only way to see a handle stay cold while its
 * neighbours are warm.
 */

import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { Handle } from '@/data/api'
import type { Block } from '@/data/block'
import { useManyParents } from './block.ts'

type Chain = {id: string}[]

const chainFor = (id: string): Chain => [{id: `${id}-parent`}]

/** `useHandle`/`useHandles` reach `peek()`, `status()` and
 *  `subscribe()`; `load()` only from `'idle'`, and never `read()`. */
const handleFor = (id: string, value: Chain | undefined): Handle<Chain> => ({
  key: `ancestors:${id}`,
  peek: () => value,
  load: () => Promise.resolve(value ?? []),
  subscribe: () => () => {},
  read: () => value ?? [],
  status: () => value ? 'ready' : 'loading',
})

/** Every id resolves except `cold`, and each id's handle is a stable
 *  instance — the store's same-key-same-instance guarantee, which is
 *  what the hook's subscription identity rests on. */
const makeRepo = () => {
  const acquired: string[] = []
  const handles = new Map<string, Handle<Chain>>()
  return {
    acquired,
    repo: {
      block: (id: string) => ({id}) as Block,
      query: {
        ancestors: ({id}: {id: string}) => {
          acquired.push(id)
          let handle = handles.get(id)
          if (!handle) {
            handle = handleFor(id, id.startsWith('cold') ? undefined : chainFor(id))
            handles.set(id, handle)
          }
          return handle
        },
      },
    },
  }
}

const harness = makeRepo()
vi.mock('@/context/repo.tsx', () => ({useRepo: () => harness.repo}))

const blocksFor = (ids: string[]) => ids.map(id => ({id}) as Block)

const renderWith = (ids: string[]) => renderHook(
  ({blocks}: {blocks: Block[]}) => useManyParents(blocks),
  {initialProps: {blocks: blocksFor(ids)}},
)

describe('useManyParents', () => {
  it('keeps every resolved chain when the id set changes', () => {
    const {result, rerender} = renderWith(['a', 'b'])
    expect(result.current.get('a')?.map(p => p.id)).toEqual(['a-parent'])

    // 'a' stays, 'b' leaves, 'c' enters — and 'a' does not blink.
    rerender({blocks: blocksFor(['a', 'c'])})

    expect(result.current.get('a')?.map(p => p.id)).toEqual(['a-parent'])
    expect(result.current.get('c')?.map(p => p.id)).toEqual(['c-parent'])
    expect(result.current.has('b')).toBe(false)
  })

  it('leaves an unresolved id absent rather than reporting it rootless', () => {
    // The distinction the old set-keyed shape could not make: a
    // consumer reserves the breadcrumb line for "not yet" and renders
    // none for a genuine root.
    const {result} = renderWith(['a', 'cold-1'])

    expect(result.current.get('a')?.map(p => p.id)).toEqual(['a-parent'])
    expect(result.current.has('cold-1')).toBe(false)
  })

  it('re-acquires nothing when the caller re-renders with an equal id set', () => {
    const {rerender} = renderWith(['a', 'b'])
    const afterFirstRender = harness.acquired.length

    // A fresh array of the same ids, in a different order: the handle
    // array must stay identical or every render re-subscribes.
    rerender({blocks: blocksFor(['b', 'a'])})

    expect(harness.acquired.length).toBe(afterFirstRender)
  })

  it('survives an empty id set passing through', () => {
    // A list handle that re-keys (turning a backlinks filter on)
    // reports `[]` for a beat.
    const {result, rerender} = renderWith(['a', 'b'])

    rerender({blocks: []})
    expect(result.current.size).toBe(0)

    rerender({blocks: blocksFor(['a'])})
    expect(result.current.get('a')?.map(p => p.id)).toEqual(['a-parent'])
  })
})
