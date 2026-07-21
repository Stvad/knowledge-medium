// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { grabSoftKeyboard } from '@/utils/softKeyboardGrab'

/** Stub the platform signals the iOS gate reads. */
const setPlatform = (vendor: string, maxTouchPoints: number, userAgent = '') => {
  vi.stubGlobal('navigator', {vendor, maxTouchPoints, userAgent})
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
    // Realistic Android Chrome UA — has "Chrome/" but NOT "CriOS/", so the
    // non-Safari-iOS UA fallback must not mistake it for iOS.
    setPlatform('Google Inc.', 5, 'Mozilla/5.0 (Linux; Android 14) Chrome/120.0.0.0 Mobile Safari/537.36')
    grabSoftKeyboard()
    expect(document.querySelector('input[aria-hidden="true"]')).toBeNull()
    expect(document.activeElement).toBe(document.body)
  })

  it('focuses the proxy on a non-Safari iOS browser (Chrome for iOS: non-Apple vendor, CriOS UA)', () => {
    // Every iOS browser is WebKit and needs the grab, but iOS Chrome/Edge report
    // vendor "Google Inc." and Firefox "" — vendor alone would skip them.
    setPlatform('Google Inc.', 5, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) CriOS/120.0 Mobile/15E148 Safari/604.1')
    grabSoftKeyboard()
    const active = document.activeElement as HTMLElement | null
    expect(active?.tagName).toBe('INPUT')
    expect(active?.getAttribute('aria-hidden')).toBe('true')
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

  it('a later grab cancels the earlier grab\'s failsafe so it can\'t blur mid-handoff', () => {
    // The block→block case: tap A (arms a failsafe), then tap B ~before A's
    // failsafe fires. B re-focuses the same singleton proxy; A's stale timer
    // must be cancelled, or it fires mid-handoff and drops B's keyboard.
    vi.useFakeTimers()
    IOS()
    grabSoftKeyboard() // tap A — failsafe armed for t+3000
    const proxy = document.activeElement as HTMLElement
    expect(proxy.tagName).toBe('INPUT')

    vi.advanceTimersByTime(2900) // still holding the keyboard, A's timer not yet due
    proxy.focus() // proxy still owns focus (editor hasn't taken over)
    grabSoftKeyboard() // tap B — must cancel A's timer and arm a fresh one

    vi.advanceTimersByTime(200) // t=3100: past when A's original timer would have fired
    // With per-call timers, A's would have blurred the proxy at 3000; the single
    // cancel-and-rearm timer keeps the keyboard up for B's handoff.
    expect(document.activeElement).toBe(proxy)
  })
})
