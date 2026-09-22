// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getKeyboardOverlap,
  getKeyboardTop,
  keyboardTop,
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

describe('keyboardTop', () => {
  // The mobile editing toolbar's bottom edge: the visual viewport's offset
  // (the iOS pan) plus its height, both layout-viewport coordinates.
  it('is the visual viewport height when unscrolled (iOS, no pan)', () => {
    expect(keyboardTop(0, 314)).toBe(314)
  })

  it('moves down with the pan as the page scrolls with the keyboard up', () => {
    // Device-verified iPad case: vv 314 tall, panned by 277.
    expect(keyboardTop(277, 314)).toBe(591)
  })

  it('rounds fractional sub-pixel viewport metrics to a whole px', () => {
    expect(keyboardTop(0.4, 313.7)).toBe(314)
  })
})

describe('getKeyboardTop', () => {
  it('reads the live visual viewport', () => {
    // Device-verified standalone iPhone: keyboard shrinks vv to 518, no pan;
    // the toolbar's bottom edge belongs at 518 whatever the layout height reads.
    installViewport({height: 518})
    expect(getKeyboardTop()).toBe(518)
  })

  it('is undefined without a visual viewport, where bottom:0 is already right', () => {
    vi.stubGlobal('visualViewport', undefined)
    expect(getKeyboardTop()).toBeUndefined()
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
