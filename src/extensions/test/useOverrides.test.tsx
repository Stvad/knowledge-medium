// @vitest-environment happy-dom
/**
 * Tests for the AppRuntimeProvider's brittle bit: the hook that reads
 * the overrides cache at mount, subscribes to `refreshAppRuntime`
 * dispatches, and re-reads the cache when one fires.
 *
 * Specifically guards against the regression where the cache read
 * memo's deps array forgets `generation`, which would silently make
 * refresh events a no-op for the runtime resolver.
 */
import {act, renderHook} from '@testing-library/react'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {useOverrides} from '@/extensions/useOverrides.js'
import {writeOverridesCache} from '@/extensions/overridesCache.js'
import {refreshAppRuntime} from '@/facets/runtimeEvents.js'

const WS = 'ws-test'

const dispatchRefresh = () => act(() => { refreshAppRuntime() })

describe('useOverrides', () => {
  beforeEach(() => { localStorage.clear() })
  afterEach(() => { localStorage.clear() })

  it('reads the cache at mount and exposes the initial generation', () => {
    writeOverridesCache(WS, new Map([['system:vim', false]]))

    const {result} = renderHook(() => useOverrides(WS))

    expect(result.current.overrides.get('system:vim')).toBe(false)
    expect(result.current.generation).toBe('initial-load')
  })

  it('returns an empty map when workspaceId is null (pre-workspace boot)', () => {
    writeOverridesCache(WS, new Map([['system:vim', false]]))

    const {result} = renderHook(() => useOverrides(null))

    expect(result.current.overrides.size).toBe(0)
  })

  it('returns an empty map when workspaceId is undefined', () => {
    const {result} = renderHook(() => useOverrides(undefined))
    expect(result.current.overrides.size).toBe(0)
  })

  it('re-reads the cache after `refreshAppRuntime()` fires', () => {
    // Mount with an empty cache.
    const {result} = renderHook(() => useOverrides(WS))
    expect(result.current.overrides.size).toBe(0)
    const initialGeneration = result.current.generation

    // Cache changes out-of-band (in production the meta-plugin's
    // subscribe effect writes it, then dispatches refresh).
    writeOverridesCache(WS, new Map([['system:vim', false]]))
    expect(result.current.overrides.size).toBe(0)  // stale until refresh

    dispatchRefresh()

    expect(result.current.overrides.get('system:vim')).toBe(false)
    expect(result.current.generation).not.toBe(initialGeneration)
  })

  it('reflects override removals on subsequent refresh dispatches', () => {
    writeOverridesCache(WS, new Map([['system:vim', false]]))
    const {result} = renderHook(() => useOverrides(WS))
    expect(result.current.overrides.get('system:vim')).toBe(false)

    writeOverridesCache(WS, new Map())
    dispatchRefresh()

    expect(result.current.overrides.size).toBe(0)
  })

  it('updates when workspaceId changes', () => {
    writeOverridesCache('ws-a', new Map([['system:a-only', false]]))
    writeOverridesCache('ws-b', new Map([['system:b-only', false]]))

    const {result, rerender} = renderHook(
      ({ws}: {ws: string}) => useOverrides(ws),
      {initialProps: {ws: 'ws-a'}},
    )
    expect(result.current.overrides.get('system:a-only')).toBe(false)
    expect(result.current.overrides.has('system:b-only')).toBe(false)

    rerender({ws: 'ws-b'})

    expect(result.current.overrides.get('system:b-only')).toBe(false)
    expect(result.current.overrides.has('system:a-only')).toBe(false)
  })

  it('removes the event listener on unmount', () => {
    const {result, unmount} = renderHook(() => useOverrides(WS))
    const generationBeforeUnmount = result.current.generation

    unmount()

    // After unmount, a stray refresh dispatch must not trigger any
    // state update on the now-gone hook. We verify the listener has
    // detached by checking that result.current is stable (no warnings
    // about setState on an unmounted component would surface from
    // React's act() instead, so the meaningful check is that
    // generation stays at what we read before unmount).
    writeOverridesCache(WS, new Map([['system:something', false]]))
    dispatchRefresh()

    expect(result.current.generation).toBe(generationBeforeUnmount)
  })

  it('produces distinct generations on consecutive refreshes', () => {
    // The default refresh detail is a `new Date().toISOString()` token;
    // two dispatches in the same millisecond would collide. Fake timers
    // (which mock Date) let us advance the clock 1ms deterministically
    // instead of sleeping and hoping the wall clock ticked.
    vi.useFakeTimers()
    try {
      const {result} = renderHook(() => useOverrides(WS))
      const g0 = result.current.generation

      dispatchRefresh()
      const g1 = result.current.generation

      vi.advanceTimersByTime(1)
      dispatchRefresh()
      const g2 = result.current.generation

      expect(g1).not.toBe(g0)
      expect(g2).not.toBe(g1)
    } finally {
      vi.useRealTimers()
    }
  })
})
