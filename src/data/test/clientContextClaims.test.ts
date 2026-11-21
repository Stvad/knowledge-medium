// @vitest-environment happy-dom
/**
 * ClientContext layout-context claim registry — the localStorage-backed
 * persistence half, which the node-env clientContext.test.ts can't reach.
 * Multiple ClientContext instances in one test stand in for multiple TABS
 * (each tab constructs its own instance over the same localStorage).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientContext } from '@/data/clientContext'

const tab = (name: string) => new ClientContext({user: {id: 'user-1', name}})

beforeEach(() => {
  localStorage.clear()
})

describe('ClientContext layout-context claims (persistence)', () => {
  it('persists claims across constructions (the bootstrap-sees-earlier-boots contract)', () => {
    tab('first-boot').claimLayoutContextKey('ws-1', 'persp')
    expect(tab('next-boot').hasClaimedLayoutContextKey('ws-1', 'persp')).toBe(true)
  })

  it('merges concurrent tabs\' writes instead of last-writer-wins', () => {
    // Both tabs snapshot the (empty) map at construction; each then claims
    // for a different workspace. A whole-map overwrite from either
    // snapshot would drop the other's claim.
    const tabA = tab('a')
    const tabB = tab('b')
    tabA.claimLayoutContextKey('ws-a', 'persp')
    tabB.claimLayoutContextKey('ws-b', 'persp')

    const reboot = tab('reboot')
    expect(reboot.hasClaimedLayoutContextKey('ws-a', 'persp')).toBe(true)
    expect(reboot.hasClaimedLayoutContextKey('ws-b', 'persp')).toBe(true)
  })

  it('release persists and merges the same way', () => {
    const tabA = tab('a')
    tabA.claimLayoutContextKey('ws-a', 'persp')
    tabA.claimLayoutContextKey('ws-a', 'other')
    const tabB = tab('b')
    tabB.claimLayoutContextKey('ws-b', 'persp')
    tabA.releaseLayoutContextKey('ws-a', 'persp')

    const reboot = tab('reboot')
    expect(reboot.hasClaimedLayoutContextKey('ws-a', 'persp')).toBe(false)
    expect(reboot.hasClaimedLayoutContextKey('ws-a', 'other')).toBe(true)
    expect(reboot.hasClaimedLayoutContextKey('ws-b', 'persp')).toBe(true)
  })

  it('a write also absorbs other tabs\' claims into the writer\'s own view', () => {
    const tabA = tab('a')
    const tabB = tab('b')
    tabA.claimLayoutContextKey('ws-a', 'persp')
    tabB.claimLayoutContextKey('ws-b', 'persp')
    // tabB's merge-on-write re-read picked up tabA's claim.
    expect(tabB.hasClaimedLayoutContextKey('ws-a', 'persp')).toBe(true)
  })

  it('a NO-OP re-claim still absorbs the persisted state (the claim postcondition)', () => {
    // Both tabs exist before any claim; A claims first, then B claims the
    // SAME (scope, key) — a no-delta write against the persisted map. B's
    // in-memory view must still learn the key, or hasClaimed lies right
    // after B itself claimed and B's base session applies lane routes.
    const tabA = tab('a')
    const tabB = tab('b')
    tabA.claimLayoutContextKey('ws-1', 'persp')
    tabB.claimLayoutContextKey('ws-1', 'persp')
    expect(tabB.hasClaimedLayoutContextKey('ws-1', 'persp')).toBe(true)
  })

  it('a failed persist flips the instance to in-memory-authoritative (no silent claim loss)', () => {
    // Quota/private-mode: the write is swallowed, so storage is BEHIND the
    // in-memory map. A later mutation must not re-read storage and adopt
    // it — that would silently drop the unpersisted claim.
    const tabA = tab('a')
    // happy-dom's localStorage is a Proxy that swallows property sets, so
    // stub the GLOBAL with a quota-throwing wrapper instead.
    const real = localStorage
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => real.getItem(key),
      setItem: () => { throw new Error('quota') },
      removeItem: (key: string) => real.removeItem(key),
    })
    try {
      tabA.claimLayoutContextKey('ws-1', 'persp') // persist fails, degrades
    } finally {
      vi.unstubAllGlobals()
    }
    expect(tabA.hasClaimedLayoutContextKey('ws-1', 'persp')).toBe(true)
    tabA.claimLayoutContextKey('ws-1', 'other') // must NOT re-read stale storage
    expect(tabA.hasClaimedLayoutContextKey('ws-1', 'persp')).toBe(true)
    expect(tabA.hasClaimedLayoutContextKey('ws-1', 'other')).toBe(true)
  })

  it('a SUCCESSFUL write after degradation resumes merge-reads (one transient failure is not permanent)', () => {
    // Without the reset, one transient quota failure turns the tab into a
    // permanent whole-map last-writer — every later successful write
    // republishes its never-merged map, deleting peers' claims forever.
    const tabA = tab('a')
    const real = localStorage
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => real.getItem(key),
      setItem: () => { throw new Error('quota') },
      removeItem: (key: string) => real.removeItem(key),
    })
    try {
      tabA.claimLayoutContextKey('ws-1', 'persp') // fails → degraded
    } finally {
      vi.unstubAllGlobals()
    }
    tabA.claimLayoutContextKey('ws-1', 'other') // succeeds → heals, resets

    // Merge-reads resumed: another tab's later claim is absorbed again.
    tab('b').claimLayoutContextKey('ws-2', 'persp')
    tabA.claimLayoutContextKey('ws-1', 'third')
    expect(tabA.hasClaimedLayoutContextKey('ws-2', 'persp')).toBe(true)
  })

  it('a NO-OP mutation while degraded still retries the healing write (extension-restart recovery)', () => {
    // The common recovery path is an extension restart idempotently
    // re-claiming its keys — changed === false. Gating the healing write
    // on the delta would leave storage stale forever, and the NEXT boot
    // would read the stale claims (applying lane URLs to base again).
    const tabA = tab('a')
    const real = localStorage
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => real.getItem(key),
      setItem: () => { throw new Error('quota') },
      removeItem: (key: string) => real.removeItem(key),
    })
    try {
      tabA.claimLayoutContextKey('ws-1', 'persp') // fails → degraded
    } finally {
      vi.unstubAllGlobals()
    }
    tabA.claimLayoutContextKey('ws-1', 'persp') // storage healthy again, but a NO-OP

    // The healing write ran anyway: the next boot sees the claim.
    expect(tab('next-boot').hasClaimedLayoutContextKey('ws-1', 'persp')).toBe(true)
  })

  it('a THROWING localStorage getter (sandboxed WebView SecurityError) degrades to in-memory claims', () => {
    // In opaque-origin/sandboxed contexts merely EVALUATING `localStorage`
    // throws — and the claims read runs as a ClientContext field
    // initializer, so an unguarded access would fail Repo construction.
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('SecurityError: access denied') },
    })
    try {
      const tabX = tab('sandboxed') // must not throw
      tabX.claimLayoutContextKey('ws-1', 'persp') // must not throw
      expect(tabX.hasClaimedLayoutContextKey('ws-1', 'persp')).toBe(true)
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
      else delete (globalThis as Record<string, unknown>).localStorage
    }
  })

  it('a NO-OP release still absorbs the persisted state', () => {
    const tabA = tab('a')
    tabA.claimLayoutContextKey('ws-1', 'persp')
    const tabB = tab('b') // sees the claim from construction
    tabA.releaseLayoutContextKey('ws-1', 'persp')
    tabB.releaseLayoutContextKey('ws-1', 'persp') // no-delta vs persisted
    expect(tabB.hasClaimedLayoutContextKey('ws-1', 'persp')).toBe(false)
  })
})
