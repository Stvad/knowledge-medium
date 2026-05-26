import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { actionsFacet, headerItemsFacet } from '@/extensions/core.js'
import { resolveFacetRuntimeSync } from '@/extensions/facet.js'
import { THEME_STORAGE_KEY, themeTogglePlugin, toggleThemeAction } from '../index.ts'

describe('themeTogglePlugin', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    window.localStorage.removeItem(THEME_STORAGE_KEY)
  })

  afterEach(() => {
    document.documentElement.removeAttribute('data-theme')
    window.localStorage.removeItem(THEME_STORAGE_KEY)
  })

  it('contributes the theme toggle action without a header item', () => {
    const runtime = resolveFacetRuntimeSync(themeTogglePlugin)

    expect(runtime.read(actionsFacet)).toEqual([toggleThemeAction])
    expect(runtime.read(headerItemsFacet)).toEqual([])
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
