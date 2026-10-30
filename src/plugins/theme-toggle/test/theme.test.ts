// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyTheme,
  applyThemeId,
  FALLBACK_THEME,
  setThemeRegistry,
  syncLiveThemeMode,
  THEME_MODE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  toggleTheme,
  type ThemeDefinition,
} from '../theme.ts'

const WARM_LIGHT: ThemeDefinition = { id: 'warm-light', label: 'Warm Light', mode: 'light' }
const WARM_DARK: ThemeDefinition = { id: 'warm-dark', label: 'Warm Dark', mode: 'dark' }

const root = document.documentElement

const reset = (): void => {
  root.removeAttribute('data-theme')
  root.removeAttribute('data-theme-mode')
  window.localStorage.removeItem(THEME_STORAGE_KEY)
  window.localStorage.removeItem(THEME_MODE_STORAGE_KEY)
}

describe('theme mode on the document root', () => {
  beforeEach(() => {
    reset()
    setThemeRegistry([WARM_LIGHT, WARM_DARK])
  })

  afterEach(() => {
    reset()
    setThemeRegistry([FALLBACK_THEME])
  })

  it('applyTheme writes and persists the mode beside the id', () => {
    applyTheme(WARM_DARK.id)

    expect(root.dataset.theme).toBe('warm-dark')
    expect(root.dataset.themeMode).toBe('dark')
    expect(window.localStorage.getItem(THEME_MODE_STORAGE_KEY)).toBe('dark')
  })

  it('toggleTheme moves the mode with the id', () => {
    applyTheme(WARM_DARK)
    toggleTheme()

    expect(root.dataset.theme).toBe('warm-light')
    expect(root.dataset.themeMode).toBe('light')
    expect(window.localStorage.getItem(THEME_MODE_STORAGE_KEY)).toBe('light')
  })

  it('applyThemeId keeps an unregistered id verbatim and drops the stale mode', () => {
    applyTheme(WARM_DARK)
    applyThemeId('not-registered-yet')

    expect(root.dataset.theme).toBe('not-registered-yet')
    expect(root.dataset.themeMode).toBeUndefined()
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('not-registered-yet')
    expect(window.localStorage.getItem(THEME_MODE_STORAGE_KEY)).toBeNull()
  })

  it('applyThemeId takes the mode of a registered id from the registry', () => {
    applyThemeId(WARM_DARK.id)

    expect(root.dataset.themeMode).toBe('dark')
  })

  it('syncLiveThemeMode stamps and persists the mode of a persisted id that registered after it was set', () => {
    // A persisted id the pre-paint script set without a mode (nothing was
    // persisted for it yet), before the registry knew the id.
    window.localStorage.setItem(THEME_STORAGE_KEY, WARM_DARK.id)
    root.dataset.theme = WARM_DARK.id

    syncLiveThemeMode()

    expect(root.dataset.themeMode).toBe('dark')
    expect(window.localStorage.getItem(THEME_MODE_STORAGE_KEY)).toBe('dark')
  })

  it('syncLiveThemeMode persists nothing for a default pre-paint picked from the system preference', () => {
    root.dataset.theme = WARM_DARK.id

    syncLiveThemeMode()

    expect(root.dataset.themeMode).toBe('dark')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()
    expect(window.localStorage.getItem(THEME_MODE_STORAGE_KEY)).toBeNull()
  })

  it('syncLiveThemeMode leaves a newer choice another tab persisted alone', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, WARM_LIGHT.id)
    root.dataset.theme = WARM_DARK.id

    syncLiveThemeMode()

    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe(WARM_LIGHT.id)
    expect(window.localStorage.getItem(THEME_MODE_STORAGE_KEY)).toBeNull()
  })

  it('toggleTheme treats an unregistered live theme as the first registered one', () => {
    applyTheme({ id: 'off-cycle', label: 'Off cycle', mode: 'light' })

    toggleTheme()

    expect(root.dataset.theme).toBe(WARM_DARK.id)
    expect(root.dataset.themeMode).toBe('dark')
  })

  it('syncLiveThemeMode leaves an unregistered live theme alone', () => {
    applyTheme({ id: 'off-cycle', label: 'Off cycle', mode: 'dark' })

    syncLiveThemeMode()

    expect(root.dataset.theme).toBe('off-cycle')
    expect(root.dataset.themeMode).toBe('dark')
  })
})
