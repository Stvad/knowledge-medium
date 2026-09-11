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
 *  `subscribe()`; `load()` only from `'idle'` or `'error'`, and never
 *  `read()`.
 *
 *  An unresolved handle reports `'idle'`, as a real `LoaderHandle` does
 *  before its first load — a fake that says `'loading'` there silently
 *  removes the ensure-load path from every test in the file.
 *
 *  `republish` models what a real `LoaderHandle` does on a reload: it
 *  stores the new value unconditionally and applies its structural diff
 *  only to the notify, so `peek()` returns a FRESH array even when
 *  nothing about the chain changed. */
const handleFor = (id: string, initial: Chain | undefined) => {
  let value = initial
  let loads = 0
  const listeners = new Set<(chain: Chain) => void>()
  const handle: Handle<Chain> = {
    key: `ancestors:${id}`,
    peek: () => value,
    load: () => { loads += 1; return Promise.resolve(value ?? []) },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    read: () => value ?? [],
    status: () => value ? 'ready' : 'idle',
  }
  return {
    handle,
    loadCount: () => loads,
    republish: (next: Chain) => {
      value = next
      // Structurally equal to the last value, so a real handle suppresses
      // the notify — nothing here fires either.
    },
  }
}

/** Every id resolves except `cold`, and each id's handle is a stable
 *  instance — the store's same-key-same-instance guarantee, which is
 *  what the hook's subscription identity rests on. */
const makeRepo = () => {
  const acquired: string[] = []
  const handles = new Map<string, ReturnType<typeof handleFor>>()
  return {
    acquired,
    handles,
    repo: {
      block: (id: string) => ({id}) as Block,
      query: {
        ancestors: ({id}: {id: string}) => {
          acquired.push(id)
          let entry = handles.get(id)
          if (!entry) {
            entry = handleFor(id, id.startsWith('cold') ? undefined : chainFor(id))
            handles.set(id, entry)
          }
          return entry.handle
        },
      },
    },
  }
}

const harness = makeRepo()
vi.mock('@/context/repo.js', () => ({useRepo: () => harness.repo}))

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

  it('holds the same map when a handle republishes an equal chain', () => {
    // Comparing members by identity would rebuild the map on every no-op
    // reload, and every consumer memo that closes over it.
    const {result, rerender} = renderWith(['a', 'b'])
    const first = result.current

    harness.handles.get('a')!.republish(chainFor('a'))
    rerender({blocks: blocksFor(['a', 'b'])})

    expect(result.current).toBe(first)
  })

  it('asks an unresolved member to load, and a resolved one not to', () => {
    // The ensure-load path. A fake reporting `'loading'` for a handle
    // that has never loaded hides it: `useHandles` loads from `'idle'`,
    // so nothing would ever be asked. Its own id, because the harness
    // keeps one handle per key for the whole file.
    renderWith(['a', 'cold-ensure'])

    expect(harness.handles.get('cold-ensure')!.loadCount()).toBe(1)
    expect(harness.handles.get('a')!.loadCount()).toBe(0)
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
