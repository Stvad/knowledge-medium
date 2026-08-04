// @vitest-environment happy-dom
//
// Readiness of the deck collection, specifically the window BEFORE the deck
// tag's alias has resolved.
//
// This needs a held-pending handle rather than a real DB: against real data the
// lookup settles immediately, and a page that genuinely doesn't exist resolves
// to null — neither reproduces "still loading", which is the state that was
// wrong. The bug is invisible to every test that lets the query settle first,
// which is why the gate stayed green with `tagResolved` deleted.
import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Handle } from '@/data/api'

/** Minimal Handle that starts unresolved and can be settled on demand. */
const pendingHandle = <T,>(key: string) => {
  let value: T | undefined
  const listeners = new Set<(v: T) => void>()
  const handle: Handle<T> = {
    key,
    peek: () => value,
    load: async () => value as T,
    subscribe: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    read: () => value as T,
    status: () => (value === undefined ? 'loading' : 'ready') as ReturnType<Handle<T>['status']>,
  }
  return {
    handle,
    settle: (next: T) => {
      value = next
      listeners.forEach(l => l(next))
    },
  }
}

const aliasLookup = pendingHandle<{id: string} | null>('alias')
// Both typed-block queries resolve immediately and EMPTY — the sentinel tag
// they run against matches nothing. That is precisely the trap: they report
// ready while the real tag is still unknown.
const emptyBlocks = pendingHandle<unknown[]>('blocks')
emptyBlocks.settle([])

vi.mock('@/context/repo.js', () => ({
  useRepo: () => ({
    query: {
      aliasLookup: () => aliasLookup.handle,
      typedBlocks: () => emptyBlocks.handle,
    },
  }),
}))

const { useReviewDeckCards } = await import('../useDueCards.ts')

afterEach(() => cleanupHooks())
const mounted: Array<() => void> = []
const cleanupHooks = () => {
  mounted.splice(0).forEach(unmount => unmount())
}

describe('deck readiness vs. the tag lookup', () => {
  it('is not ready while the deck tag is still being looked up', () => {
    const {result, unmount} = renderHook(() => useReviewDeckCards('ws-1', 'Flashcards'))
    mounted.push(unmount)

    // Both block queries have already resolved (empty, against the sentinel),
    // so anything that only watches them would say ready here.
    expect(result.current.newIds.size).toBe(0)
    expect(result.current.ready).toBe(false)
  })

  it('becomes ready once the tag resolves', () => {
    const {result, unmount} = renderHook(() => useReviewDeckCards('ws-1', 'Flashcards'))
    mounted.push(unmount)
    expect(result.current.ready).toBe(false)

    act(() => aliasLookup.settle({id: 'tag-1'}))

    expect(result.current.ready).toBe(true)
  })

  it('is ready immediately for the untagged all-due deck', () => {
    // No tag means no question to wait on; gating it on the lookup would leave
    // the "all due" deck permanently unready.
    const {result, unmount} = renderHook(() => useReviewDeckCards('ws-1', ''))
    mounted.push(unmount)

    expect(result.current.ready).toBe(true)
  })
})
