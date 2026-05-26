import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveFacetRuntimeSync } from '@/extensions/facet.js'
import {
  buildThemeRule,
  themeStyleSyncEffect,
} from '../effect.ts'
import {
  FALLBACK_THEME,
  getThemes,
  setThemeRegistry,
  themesFacet,
  type ThemeContribution,
} from '../theme.ts'

const SOLARIZED_DARK: ThemeContribution = {
  id: 'solarized-dark',
  label: 'Solarized Dark',
  mode: 'dark',
  tokens: {
    background: '192 100% 11%',
    foreground: '186 8% 55%',
    primary: '205 69% 49%',
  },
}

const startEffect = (
  runtime: ReturnType<typeof resolveFacetRuntimeSync>,
): (() => void) => {
  // The AppEffect start contract takes a context bag with repo /
  // workspaceId fields the theme effect doesn't use; cast through
  // never since the test path only touches `runtime`.
  const dispose = themeStyleSyncEffect.start({ runtime } as never)
  if (typeof dispose !== 'function') {
    throw new Error('themeStyleSyncEffect.start did not return a dispose function')
  }
  return dispose
}

const getManagedStyleEl = (): HTMLStyleElement | null =>
  document.head.querySelector<HTMLStyleElement>('style[data-theme-plugin-managed]')

describe('buildThemeRule', () => {
  it('emits a [data-theme="<id>"] block with --token: value lines', () => {
    expect(buildThemeRule(SOLARIZED_DARK)).toBe(
      `[data-theme="solarized-dark"] {\n` +
        `  --background: 192 100% 11%;\n` +
        `  --foreground: 186 8% 55%;\n` +
        `  --primary: 205 69% 49%;\n` +
        `}`,
    )
  })
})

describe('themeStyleSyncEffect', () => {
  beforeEach(() => {
    setThemeRegistry([FALLBACK_THEME])
    getManagedStyleEl()?.remove()
  })

  afterEach(() => {
    setThemeRegistry([FALLBACK_THEME])
    getManagedStyleEl()?.remove()
  })

  it('injects a managed <style> and extends the cycle registry on start', () => {
    const runtime = resolveFacetRuntimeSync([
      themesFacet.of(SOLARIZED_DARK, { source: 'test-theme' }),
    ])
    const dispose = startEffect(runtime)

    const styleEl = getManagedStyleEl()
    expect(styleEl).not.toBeNull()
    expect(styleEl?.textContent).toContain('[data-theme="solarized-dark"]')
    expect(styleEl?.textContent).toContain('--background: 192 100% 11%;')

    expect(getThemes().map((t) => t.id)).toEqual(['solarized-dark'])

    dispose()
  })

  it('falls back to the bootstrap sentinel when no themes are contributed', () => {
    const runtime = resolveFacetRuntimeSync([])
    const dispose = startEffect(runtime)

    expect(getManagedStyleEl()?.textContent).toBe('')
    expect(getThemes()).toEqual([FALLBACK_THEME])

    dispose()
  })

  it('rebuilds the stylesheet and registry when the facet changes', () => {
    const runtime = resolveFacetRuntimeSync([])
    const dispose = startEffect(runtime)

    expect(getThemes()).toEqual([FALLBACK_THEME])

    runtime.setRuntimeContributions(themesFacet, 'runtime-source', [
      SOLARIZED_DARK,
    ])

    expect(getManagedStyleEl()?.textContent).toContain('solarized-dark')
    expect(getThemes().map((t) => t.id)).toEqual(['solarized-dark'])

    dispose()
  })

  it('removes the style element and restores the bootstrap registry on dispose', () => {
    const runtime = resolveFacetRuntimeSync([
      themesFacet.of(SOLARIZED_DARK, { source: 'test-theme' }),
    ])
    const dispose = startEffect(runtime)
    expect(getManagedStyleEl()).not.toBeNull()
    expect(getThemes()).toHaveLength(1)

    dispose()

    expect(getManagedStyleEl()).toBeNull()
    expect(getThemes()).toEqual([FALLBACK_THEME])
  })
})
