// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getClientId, getDeviceLabel, isClientIdPersistent, resetClientIdCache } from '@/utils/clientId'

afterEach(() => { resetClientIdCache(); vi.restoreAllMocks() })

describe('isClientIdPersistent', () => {
  it('is true when the id round-trips through localStorage', () => {
    expect(isClientIdPersistent()).toBe(true)
    const first = getClientId()
    resetClientIdCache()
    expect(getClientId()).toBe(first)
  })

  // The case that matters: a browser that accepts the write and keeps nothing
  // hands out a fresh id every load, so anything keyed on it accumulates
  // history the next session can never read.
  it('is false when the store accepts the write but keeps nothing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(null)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {})
    expect(isClientIdPersistent()).toBe(false)
  })

  it('is false when storage access throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError') })
    expect(isClientIdPersistent()).toBe(false)
    expect(getClientId()).toBeTruthy()
  })
})

/**
 * The label SELECTS a device's series, so it must not change under an
 * installation. `navigator.platform` is stable but deprecated and may be empty;
 * the fallback derives an OS family rather than quoting the user agent, whose
 * version numbers move on every upgrade — which would orphan the baseline and
 * strand the old rows beyond retention's reach.
 */
describe('getDeviceLabel', () => {
  const withNavigator = <T>(platform: string, userAgent: string, fn: () => T): T => {
    const spy = vi.spyOn(globalThis, 'navigator', 'get')
    spy.mockReturnValue({ platform, userAgent } as Navigator)
    try { return fn() } finally { spy.mockRestore() }
  }

  it('survives an OS or browser upgrade when platform is empty', () => {
    const before = withNavigator('', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120', getDeviceLabel)
    const after = withNavigator('', 'Mozilla/5.0 (Linux; Android 15; Pixel 8) Chrome/131', getDeviceLabel)
    expect(after).toBe(before)
    expect(before).toContain('Android')
  })

  it('still separates genuinely different platforms', () => {
    const android = withNavigator('', 'Mozilla/5.0 (Linux; Android 14) Chrome/120', getDeviceLabel)
    const windows = withNavigator('', 'Mozilla/5.0 (Windows NT 10.0) Chrome/120', getDeviceLabel)
    expect(android).not.toBe(windows)
  })

  it('prefers the stable platform string when there is one', () => {
    expect(withNavigator('MacIntel', 'Mozilla/5.0 (Macintosh) Chrome/120', getDeviceLabel))
      .toContain('MacIntel')
  })
})
