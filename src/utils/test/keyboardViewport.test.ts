import { afterEach, describe, expect, it, vi } from 'vitest'
import { getKeyboardOverlap, subscribeKeyboardViewport } from '@/utils/keyboardViewport'

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
})
