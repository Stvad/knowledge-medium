// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  FALLBACK_THEME,
  setThemeRegistry,
  THEME_STORAGE_KEY,
  toggleThemeAction,
} from '../index.ts'

describe('themeTogglePlugin', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    window.localStorage.removeItem(THEME_STORAGE_KEY)
    // The action exercises whatever the registry currently holds.
    // Seed it with a two-theme cycle so toggle has somewhere to go;
    // in real runs the style-sync effect would populate this from
    // themesFacet contributions (light/dark are contributed by the
    // default-themes plugin).
    setThemeRegistry([
      { id: 'light', label: 'Light', mode: 'light' },
      { id: 'dark', label: 'Dark', mode: 'dark' },
    ])
  })

  afterEach(() => {
    document.documentElement.removeAttribute('data-theme')
    window.localStorage.removeItem(THEME_STORAGE_KEY)
    setThemeRegistry([FALLBACK_THEME])
  })

  it('cycles the document theme from its command action and persists it', () => {
    toggleThemeAction.handler({} as never, new CustomEvent('test'))
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')

    toggleThemeAction.handler({} as never, new CustomEvent('test'))
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
  })
})
