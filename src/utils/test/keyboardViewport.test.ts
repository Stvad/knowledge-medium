// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getKeyboardOverlap,
  layoutViewportKeyboardOverlap,
  setEditingToolbarHeight,
  subscribeKeyboardViewport,
} from '@/utils/keyboardViewport'

/** Minimal stand-in for window.visualViewport that lets tests drive the
 *  height/offsetTop the overlap formula reads, and records listeners so
 *  the subscribe lifecycle can be asserted. */
const installViewport = (initial: {height: number; offsetTop?: number}) => {
  const listeners = new Map<string, Set<() => void>>()
  const vv = {
    height: initial.height,
    offsetTop: initial.offsetTop ?? 0,
    addEventListener: (type: string, cb: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(cb)
    },
    removeEventListener: (type: string, cb: () => void) => {
      listeners.get(type)?.delete(cb)
    },
    emit: (type: string) => listeners.get(type)?.forEach(cb => cb()),
    listenerCount: () =>
      [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  }
  vi.stubGlobal('visualViewport', vv)
  return vv
}

afterEach(() => {
  vi.unstubAllGlobals()
  // Module-level state — reset so it doesn't bleed between tests.
  setEditingToolbarHeight(0)
})

describe('getKeyboardOverlap', () => {
  it('reports the keyboard height when the layout viewport stays full (iOS Safari / Edge)', () => {
    vi.stubGlobal('innerHeight', 800)
    installViewport({height: 500})
    expect(getKeyboardOverlap()).toBe(300)
  })

  it('reports zero when the layout viewport shrinks with the keyboard (Chrome resizes-content)', () => {
    vi.stubGlobal('innerHeight', 500)
    installViewport({height: 500})
    expect(getKeyboardOverlap()).toBe(0)
  })

  it('stays URL-bar invariant by subtracting the visual viewport offset', () => {
    // Visual viewport pushed down by 60px (URL bar) and 240px shorter:
    // only the keyboard portion (800 - 60 - 500) should count.
    vi.stubGlobal('innerHeight', 800)
    installViewport({height: 500, offsetTop: 60})
    expect(getKeyboardOverlap()).toBe(240)
  })

  it('never goes negative', () => {
    vi.stubGlobal('innerHeight', 500)
    installViewport({height: 760})
    expect(getKeyboardOverlap()).toBe(0)
  })
})

describe('layoutViewportKeyboardOverlap', () => {
  // The mobile editing toolbar's `position:fixed; bottom` inset. Layout height
  // is documentElement.clientHeight (stays full on iOS while the keyboard is
  // up); the load-bearing term is subtracting the visual viewport's offsetTop
  // (the iOS pan), which the pre-fix formula omitted and so over-lifted the bar
  // after any scroll.
  it('lifts the toolbar by the keyboard height when unscrolled (iOS, no pan)', () => {
    // Real iPad: clientHeight 650, keyboard shrinks vv to 314, not scrolled.
    expect(layoutViewportKeyboardOverlap(650, 314, 0)).toBe(336)
  })

  it('shrinks the inset by the pan as the page scrolls with the keyboard up', () => {
    // Same iPad, scrolled so iOS pans the visual viewport down by 277 — the
    // device-verified case (rendered style.bottom was 59px). Dropping offsetTop
    // would wrongly yield 336 and fling the bar toward the top.
    expect(layoutViewportKeyboardOverlap(650, 314, 277)).toBe(59)
  })

  it('is 0 with no keyboard (visual viewport fills the layout viewport)', () => {
    expect(layoutViewportKeyboardOverlap(650, 650, 0)).toBe(0)
  })

  it('is ~0 when the layout viewport shrinks with the keyboard (Chromium resizes-content)', () => {
    // clientHeight and vv.height shrink together, no pan → bottom:0 already clears.
    expect(layoutViewportKeyboardOverlap(433, 434, 0)).toBe(0)
  })

  it('never goes negative', () => {
    expect(layoutViewportKeyboardOverlap(500, 760, 0)).toBe(0)
  })

  it('rounds fractional sub-pixel viewport metrics to a whole px', () => {
    // Real devices report fractional vv.height / offsetTop (sub-pixel DPR),
    // and the inset feeds a CSS px `bottom`. 650 - 313.7 - 0.4 = 335.9, so a
    // proper round yields 336; dropping Math.round (335.9) or swapping it for
    // floor/trunc (335) would diverge — this pins the rounding.
    expect(layoutViewportKeyboardOverlap(650, 313.7, 0.4)).toBe(336)
  })
})

describe('subscribeKeyboardViewport', () => {
  it('attaches on first subscriber and detaches once the last leaves', () => {
    const vv = installViewport({height: 500})
    expect(vv.listenerCount()).toBe(0)

    const unsubA = subscribeKeyboardViewport(() => {})
    const unsubB = subscribeKeyboardViewport(() => {})
    expect(vv.listenerCount()).toBeGreaterThan(0)

    unsubA()
    expect(vv.listenerCount()).toBeGreaterThan(0) // B still listening
    unsubB()
    expect(vv.listenerCount()).toBe(0)
  })

  it('notifies subscribers when the viewport changes', () => {
    const vv = installViewport({height: 500})
    const seen = vi.fn()
    const unsub = subscribeKeyboardViewport(seen)

    vv.emit('resize')
    vv.emit('scroll')
    expect(seen).toHaveBeenCalledTimes(2)

    unsub()
    vv.emit('resize')
    expect(seen).toHaveBeenCalledTimes(2) // no longer notified
  })

  it('notifies subscribers when the editing toolbar height changes', () => {
    installViewport({height: 500})
    const seen = vi.fn()
    const unsub = subscribeKeyboardViewport(seen)

    setEditingToolbarHeight(48)
    expect(seen).toHaveBeenCalledTimes(1)

    setEditingToolbarHeight(48) // unchanged — no notification
    expect(seen).toHaveBeenCalledTimes(1)

    unsub()
  })
})
