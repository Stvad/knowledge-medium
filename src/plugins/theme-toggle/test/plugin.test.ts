import { describe, expect, it } from 'vitest'
import { actionsFacet, headerItemsFacet } from '@/extensions/core.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { themeTogglePlugin, toggleThemeAction } from '../index.ts'

describe('themeTogglePlugin', () => {
  it('contributes the theme toggle action without a header item', () => {
    const runtime = resolveFacetRuntimeSync(themeTogglePlugin)

    expect(runtime.read(actionsFacet)).toEqual([toggleThemeAction])
    expect(runtime.read(headerItemsFacet)).toEqual([])
  })

  it('toggles the document theme from its command action', () => {
    document.documentElement.classList.remove('light', 'dark')

    toggleThemeAction.handler({} as never, new CustomEvent('test'))
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.classList.contains('light')).toBe(false)

    toggleThemeAction.handler({} as never, new CustomEvent('test'))
    expect(document.documentElement.classList.contains('light')).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })
})
