import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  __resetLayoutSessionIdForTesting,
  BROWSER_LAYOUT_SESSION_ID_STORAGE_KEY,
  INSTALLED_APP_LAYOUT_SESSION_ID_STORAGE_KEY,
  getLayoutSessionId,
  isInstalledAppDisplayMode,
  readOrCreateLayoutSessionId,
  type LayoutSessionIdStorage,
} from '@/utils/layoutSessionId'

class MemoryStorage implements LayoutSessionIdStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

const setDisplayMode = (activeMode: string | null): void => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: activeMode ? query === `(display-mode: ${activeMode})` : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
  Object.defineProperty(window.navigator, 'standalone', {
    configurable: true,
    value: false,
  })
}

beforeEach(() => {
  __resetLayoutSessionIdForTesting()
  window.sessionStorage.clear()
  window.localStorage.clear()
  setDisplayMode(null)
})

describe('getLayoutSessionId', () => {
  it('persists the generated id in sessionStorage for a browser tab', () => {
    const first = getLayoutSessionId()
    expect(window.sessionStorage.getItem(BROWSER_LAYOUT_SESSION_ID_STORAGE_KEY)).toBe(first)
    expect(window.localStorage.getItem(INSTALLED_APP_LAYOUT_SESSION_ID_STORAGE_KEY)).toBeNull()
    __resetLayoutSessionIdForTesting()
    expect(getLayoutSessionId()).toBe(first)
  })

  it('persists the generated id in localStorage for installed app display modes', () => {
    setDisplayMode('standalone')

    const first = getLayoutSessionId()
    expect(window.localStorage.getItem(INSTALLED_APP_LAYOUT_SESSION_ID_STORAGE_KEY)).toBe(first)
    expect(window.sessionStorage.getItem(BROWSER_LAYOUT_SESSION_ID_STORAGE_KEY)).toBeNull()
    __resetLayoutSessionIdForTesting()
    expect(getLayoutSessionId()).toBe(first)
  })

  it('memoizes within the module lifetime', () => {
    const first = getLayoutSessionId()
    window.sessionStorage.setItem(BROWSER_LAYOUT_SESSION_ID_STORAGE_KEY, 'external-change')
    expect(getLayoutSessionId()).toBe(first)
  })
})

describe('isInstalledAppDisplayMode', () => {
  it('detects standalone display mode', () => {
    setDisplayMode('standalone')
    expect(isInstalledAppDisplayMode()).toBe(true)
  })

  it('detects iOS standalone mode', () => {
    Object.defineProperty(window.navigator, 'standalone', {
      configurable: true,
      value: true,
    })
    expect(isInstalledAppDisplayMode()).toBe(true)
  })
})

describe('readOrCreateLayoutSessionId', () => {
  it('reuses an existing storage value', () => {
    const storage = new MemoryStorage()
    storage.setItem(BROWSER_LAYOUT_SESSION_ID_STORAGE_KEY, 'layout-session-existing')

    expect(readOrCreateLayoutSessionId(
      storage,
      BROWSER_LAYOUT_SESSION_ID_STORAGE_KEY,
      () => 'layout-session-new',
    )).toBe('layout-session-existing')
  })

  it('keeps simulated browser layout sessions independent by using each storage', () => {
    const sessionA = new MemoryStorage()
    const sessionB = new MemoryStorage()

    expect(readOrCreateLayoutSessionId(sessionA, BROWSER_LAYOUT_SESSION_ID_STORAGE_KEY, () => 'session-a')).toBe('session-a')
    expect(readOrCreateLayoutSessionId(sessionB, BROWSER_LAYOUT_SESSION_ID_STORAGE_KEY, () => 'session-b')).toBe('session-b')
    expect(readOrCreateLayoutSessionId(sessionA, BROWSER_LAYOUT_SESSION_ID_STORAGE_KEY, () => 'unused')).toBe('session-a')
    expect(readOrCreateLayoutSessionId(sessionB, BROWSER_LAYOUT_SESSION_ID_STORAGE_KEY, () => 'unused')).toBe('session-b')
  })
})
