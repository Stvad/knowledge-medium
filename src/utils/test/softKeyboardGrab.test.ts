// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { grabSoftKeyboard } from '@/utils/softKeyboardGrab'

/** Stub the platform signals the iOS gate reads. */
const setPlatform = (vendor: string, maxTouchPoints: number) => {
  vi.stubGlobal('navigator', {vendor, maxTouchPoints})
}
const IOS = () => setPlatform('Apple Computer, Inc.', 5)

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  // Drop the module's singleton proxy from the DOM so the next test recreates it.
  document.body.replaceChildren()
})

describe('grabSoftKeyboard', () => {
  it('focuses a hidden proxy input on iOS', () => {
    IOS()
    grabSoftKeyboard()
    const active = document.activeElement as HTMLElement | null
    expect(active?.tagName).toBe('INPUT')
    expect(active?.getAttribute('aria-hidden')).toBe('true')
  })

  it('is a no-op on Android (raises the keyboard fine on its own; the proxy would flash-hide it)', () => {
    setPlatform('Google Inc.', 5)
    grabSoftKeyboard()
    expect(document.querySelector('input[aria-hidden="true"]')).toBeNull()
    expect(document.activeElement).toBe(document.body)
  })

  it('is a no-op on desktop Safari (Apple vendor but no touch)', () => {
    setPlatform('Apple Computer, Inc.', 0)
    grabSoftKeyboard()
    expect(document.querySelector('input[aria-hidden="true"]')).toBeNull()
  })

  it('reuses the same proxy across taps', () => {
    IOS()
    grabSoftKeyboard()
    const first = document.activeElement
    if (first) (first as HTMLElement).blur()
    grabSoftKeyboard()
    expect(document.activeElement).toBe(first)
  })

  it('blurs the proxy after the handoff timeout if nothing else took focus', () => {
    vi.useFakeTimers()
    IOS()
    grabSoftKeyboard()
    const proxy = document.activeElement
    expect((proxy as HTMLElement)?.tagName).toBe('INPUT')
    vi.advanceTimersByTime(3000)
    expect(document.activeElement).not.toBe(proxy)
  })

  it('leaves focus alone if the editor took over before the timeout', () => {
    vi.useFakeTimers()
    IOS()
    grabSoftKeyboard()
    // Simulate the editor stealing focus during the async edit-entry handoff.
    const editor = document.createElement('textarea')
    document.body.appendChild(editor)
    editor.focus()
    expect(document.activeElement).toBe(editor)
    vi.advanceTimersByTime(3000)
    // The failsafe must NOT blur the editor — it only blurs a still-active proxy.
    expect(document.activeElement).toBe(editor)
  })
})
