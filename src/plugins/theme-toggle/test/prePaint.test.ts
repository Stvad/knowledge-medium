// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { injectThemeBootDefaults } from '@/../vite-plugins/injectThemeBootDefaults'
import {
  DEFAULT_THEME_ID_DARK,
  DEFAULT_THEME_ID_LIGHT,
  THEME_MODE_STORAGE_KEY,
  THEME_STORAGE_KEY,
} from '@/themeBootDefaults'

// The real index.html pre-paint script, as Vite serves it: the first
// classic (attribute-less) <script> in <head>.
const prePaintScript = (): string => {
  // A string, not `new URL(…)`: happy-dom's global URL isn't node's.
  const indexHtml = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../../index.html'),
    'utf8',
  )
  const match = /<script>([\s\S]*?)<\/script>/.exec(injectThemeBootDefaults(indexHtml))
  if (!match) throw new Error('no pre-paint <script> in index.html')
  return match[1]
}

const runPrePaint = (): void => {
  new Function(prePaintScript())()
}

const prefersDark = (matches: boolean): void => {
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches } as MediaQueryList)
}

const root = document.documentElement

const reset = (): void => {
  root.removeAttribute('data-theme')
  root.removeAttribute('data-theme-mode')
  window.localStorage.removeItem(THEME_STORAGE_KEY)
  window.localStorage.removeItem(THEME_MODE_STORAGE_KEY)
}

describe('index.html pre-paint theme script', () => {
  beforeEach(reset)

  afterEach(() => {
    vi.restoreAllMocks()
    reset()
  })

  it('paints the dark default with the dark mode when the system prefers dark', () => {
    prefersDark(true)
    runPrePaint()

    expect(root.dataset.theme).toBe(DEFAULT_THEME_ID_DARK)
    expect(root.dataset.themeMode).toBe('dark')
  })

  it('paints the light default with the light mode when the system prefers light', () => {
    prefersDark(false)
    runPrePaint()

    expect(root.dataset.theme).toBe(DEFAULT_THEME_ID_LIGHT)
    expect(root.dataset.themeMode).toBe('light')
  })

  it('paints a persisted theme with its persisted mode, over the system preference', () => {
    prefersDark(false)
    window.localStorage.setItem(THEME_STORAGE_KEY, 'indigo-dark')
    window.localStorage.setItem(THEME_MODE_STORAGE_KEY, 'dark')
    runPrePaint()

    expect(root.dataset.theme).toBe('indigo-dark')
    expect(root.dataset.themeMode).toBe('dark')
  })

  it('sets no mode for a persisted id whose mode was never persisted', () => {
    // A theme persisted before modes were; the style-sync effect stamps
    // its mode once the registry knows the id.
    prefersDark(true)
    window.localStorage.setItem(THEME_STORAGE_KEY, 'indigo-dark')
    runPrePaint()

    expect(root.dataset.theme).toBe('indigo-dark')
    expect(root.dataset.themeMode).toBeUndefined()
  })

  it('falls back to the light default and mode when storage throws', () => {
    // Prefers dark, so only the catch branch paints light.
    prefersDark(true)
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('storage unavailable')
    })
    runPrePaint()

    expect(root.dataset.theme).toBe(DEFAULT_THEME_ID_LIGHT)
    expect(root.dataset.themeMode).toBe('light')
  })
})
