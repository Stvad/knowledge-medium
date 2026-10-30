// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyTheme,
  FALLBACK_THEME,
  setThemeRegistry,
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
})
