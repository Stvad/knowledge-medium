// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyTheme,
  FALLBACK_THEME,
  setThemeRegistry,
  syncLiveThemeMode,
  THEME_MODE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  type ThemeDefinition,
} from '@/plugins/theme-toggle/theme.js'
import { syncWolfTheme, WOLF_THEME_ID } from '../wolfTheme.ts'

const WARM_LIGHT: ThemeDefinition = { id: 'warm-light', label: 'Warm Light', mode: 'light' }

const root = document.documentElement

describe('wolf theme mode', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setThemeRegistry([WARM_LIGHT])
    applyTheme(WARM_LIGHT)
  })

  afterEach(() => {
    window.localStorage.clear()
    root.removeAttribute('data-theme')
    root.removeAttribute('data-theme-mode')
    document.getElementById('birthday-wolf-theme')?.remove()
    setThemeRegistry([FALLBACK_THEME])
  })

  it('switches to dark mode with wolf and restores the previous mode after', () => {
    syncWolfTheme(true, '2026')
    expect(root.dataset.theme).toBe(WOLF_THEME_ID)
    expect(root.dataset.themeMode).toBe('dark')

    syncWolfTheme(false, '2026')
    expect(root.dataset.theme).toBe(WARM_LIGHT.id)
    expect(root.dataset.themeMode).toBe('light')
  })

  it('restores a previous theme that has not registered yet, and its mode once it does', () => {
    const lateDark: ThemeDefinition = { id: 'late-dark', label: 'Late Dark', mode: 'dark' }
    applyTheme(lateDark)
    syncWolfTheme(true, '2026')

    syncWolfTheme(false, '2026')
    expect(root.dataset.theme).toBe(lateDark.id)
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe(lateDark.id)

    setThemeRegistry([WARM_LIGHT, lateDark])
    syncLiveThemeMode()
    expect(root.dataset.themeMode).toBe('dark')
  })

  it('restores the persisted theme from a tab that never showed wolf', () => {
    // Another tab applied and persisted wolf; this tab saw the marker and
    // kept showing the previous theme.
    syncWolfTheme(true, '2026')
    root.dataset.theme = WARM_LIGHT.id
    root.dataset.themeMode = WARM_LIGHT.mode

    syncWolfTheme(false, '2026')

    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe(WARM_LIGHT.id)
    expect(window.localStorage.getItem(THEME_MODE_STORAGE_KEY)).toBe('light')
  })
})
