// @vitest-environment happy-dom
/**
 * `useClientContext()` reactivity — a component reading `activeWorkspaceId`
 * / `activeLayoutSessionId` through the hook must re-render on an effective
 * change (P2-2: the hook previously installed no subscription at all, so
 * consumers rendered stale forever).
 *
 * Note: the hook returns the LIVE `ClientContextReader` object, not a
 * frozen-per-render snapshot — so `result.current.activeWorkspaceId` reads
 * fresh state regardless of whether a re-render happened (it would read
 * correctly even against the pre-fix, non-reactive hook). The thing that
 * actually distinguishes "reactive" from "stale" is whether a render was
 * TRIGGERED, so these tests count renders via a wrapping probe component
 * rather than trusting `result.current` alone.
 *
 * `RepoContext` is exported from `./repo.tsx` for exactly this — wiring a
 * directly-constructed `createTestRepo` Repo without the full PowerSync
 * bootstrap in `RepoProvider` (mirrors `useRendererRegistry.test.tsx`'s use
 * of the exported `AppRuntimeContextProvider`).
 */
import { act, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { RepoContext, useClientContext } from '@/context/repo.tsx'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'

let db: TestDb
let repo: Repo

beforeAll(async () => {
  db = await createTestDb()
  repo = createTestRepo({db: db.db, user: {id: 'user-1'}}).repo
})

afterAll(async () => { await db.cleanup() })
afterEach(() => {
  repo.setActiveWorkspaceId(null)
  repo.setActiveLayoutSessionId(null)
})

const wrapper = ({children}: {children: ReactNode}) => (
  <RepoContext value={repo}>{children}</RepoContext>
)

// Wraps useClientContext in a probe that counts renders — the durable way
// to prove "did / did not re-render" given the hook returns a live object
// (see the file doc above).
const renderProbe = () => {
  let renders = 0
  const useProbe = () => {
    renders++
    return useClientContext()
  }
  const rendered = renderHook(() => useProbe(), {wrapper})
  return {...rendered, renderCount: () => renders}
}

describe('useClientContext', () => {
  it('re-renders when the active workspace pin changes', () => {
    const {result, renderCount} = renderProbe()
    const before = renderCount()

    act(() => { repo.setActiveWorkspaceId('ws-reactive-1') })

    expect(renderCount()).toBeGreaterThan(before)
    expect(result.current.activeWorkspaceId).toBe('ws-reactive-1')
  })

  it('re-renders when the active layout-session id changes', () => {
    const {result, renderCount} = renderProbe()
    const before = renderCount()
    const beforeSessionId = result.current.activeLayoutSessionId

    act(() => { repo.setActiveLayoutSessionId('perspective-reactive') })

    expect(renderCount()).toBeGreaterThan(before)
    expect(result.current.activeLayoutSessionId).toBe('perspective-reactive')
    expect(result.current.activeLayoutSessionId).not.toBe(beforeSessionId)
  })

  it('does not re-render on a no-op set', () => {
    repo.setActiveWorkspaceId('ws-reactive-stable')
    const {renderCount} = renderProbe()
    const before = renderCount()

    act(() => { repo.setActiveWorkspaceId('ws-reactive-stable') })

    expect(renderCount()).toBe(before)
  })

  it('unsubscribes on unmount', () => {
    // Spy on the underlying channel to observe the subscribe/unsubscribe
    // pair directly, rather than inferring it from render counts (which
    // can't distinguish "unsubscribed" from "merely unmounted" — an
    // unmounted hook can't render either way).
    const client = repo.client
    const unsubscribeSpy = vi.fn()
    const realOnActingAsChange = client.onActingAsChange.bind(client)
    const subscribeSpy = vi.spyOn(client, 'onActingAsChange').mockImplementation((listener) => {
      const unsubscribe = realOnActingAsChange(listener)
      return () => { unsubscribeSpy(); unsubscribe() }
    })
    try {
      const {unmount} = renderHook(() => useClientContext(), {wrapper})
      expect(subscribeSpy).toHaveBeenCalledTimes(1)
      expect(unsubscribeSpy).not.toHaveBeenCalled()

      unmount()

      expect(unsubscribeSpy).toHaveBeenCalledTimes(1)
    } finally {
      subscribeSpy.mockRestore()
    }
  })
})
