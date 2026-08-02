// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dismissTutorialBanner,
  isTutorialBannerDismissed,
  resetTutorialBannerDismissal,
} from '../bannerDismissal.ts'

/** Replace `window.localStorage` with one whose methods throw, as private
 *  mode / a storage policy does. */
const withBlockedStorage = (fn: () => void): void => {
  const real = Object.getOwnPropertyDescriptor(window, 'localStorage')
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get: () => ({
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
    }),
  })
  try {
    fn()
  } finally {
    if (real) Object.defineProperty(window, 'localStorage', real)
    else delete (window as {localStorage?: unknown}).localStorage
  }
}

describe('tutorial banner dismissal', () => {
  beforeEach(() => {
    resetTutorialBannerDismissal()
    window.localStorage.clear()
  })
  afterEach(() => {
    resetTutorialBannerDismissal()
    window.localStorage.clear()
  })

  it('persists a dismissal across mounts', () => {
    expect(isTutorialBannerDismissed()).toBe(false)
    dismissTutorialBanner()
    expect(isTutorialBannerDismissed()).toBe(true)
  })

  it('keeps Dismiss effective when storage is blocked', () => {
    // The banner's own state is per-MOUNT and dies the moment you navigate to
    // another daily note, so without a module-scope fallback the prompt
    // returns on the next note and Dismiss looks broken. Re-reading here is
    // what a remount does.
    withBlockedStorage(() => {
      expect(isTutorialBannerDismissed()).toBe(false)
      expect(() => dismissTutorialBanner()).not.toThrow()
      expect(isTutorialBannerDismissed()).toBe(true)
    })
  })

  it('still shows the banner on a fresh session when storage is blocked', () => {
    // Blocked storage degrades to "dismissed until reload", not forever —
    // nothing was written, so a new page session starts clean.
    withBlockedStorage(() => {
      dismissTutorialBanner()
      resetTutorialBannerDismissal() // stands in for a page reload
      expect(isTutorialBannerDismissed()).toBe(false)
    })
  })

  it('reports not-dismissed when reading storage throws', () => {
    withBlockedStorage(() => {
      expect(isTutorialBannerDismissed()).toBe(false)
    })
  })

  it('does not leak a dismissal into an unrelated read', () => {
    dismissTutorialBanner()
    resetTutorialBannerDismissal()
    window.localStorage.clear()
    expect(isTutorialBannerDismissed()).toBe(false)
  })
})

describe('storage stub hygiene', () => {
  it('restores the real localStorage after a blocked-storage block', () => {
    withBlockedStorage(() => {})
    expect(() => window.localStorage.setItem('k', 'v')).not.toThrow()
    vi.restoreAllMocks()
  })
})
