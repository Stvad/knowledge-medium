import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'
import {
  DEFAULT_THEME_ID_DARK,
  DEFAULT_THEME_ID_LIGHT,
  THEME_STORAGE_KEY,
} from '@/themeBootDefaults'
import {
  injectThemeBootDefaults,
  THEME_BOOT_PLACEHOLDERS,
} from '@/../vite-plugins/injectThemeBootDefaults'

describe('injectThemeBootDefaults', () => {
  it('substitutes every placeholder with the JSON-quoted source-of-truth value', () => {
    const html = `
      <script>
        var stored = window.localStorage.getItem(${THEME_BOOT_PLACEHOLDERS.THEME_STORAGE_KEY})
        var fallback = prefersDark
          ? ${THEME_BOOT_PLACEHOLDERS.DEFAULT_THEME_ID_DARK}
          : ${THEME_BOOT_PLACEHOLDERS.DEFAULT_THEME_ID_LIGHT}
      </script>
    `

    const rewritten = injectThemeBootDefaults(html)

    expect(rewritten).toContain(`getItem(${JSON.stringify(THEME_STORAGE_KEY)})`)
    expect(rewritten).toContain(`? ${JSON.stringify(DEFAULT_THEME_ID_DARK)}`)
    expect(rewritten).toContain(`: ${JSON.stringify(DEFAULT_THEME_ID_LIGHT)}`)
    expect(rewritten).not.toContain('__KM_')
  })

  it('replaces every occurrence of a repeated placeholder', () => {
    const html = [
      THEME_BOOT_PLACEHOLDERS.THEME_STORAGE_KEY,
      THEME_BOOT_PLACEHOLDERS.THEME_STORAGE_KEY,
      THEME_BOOT_PLACEHOLDERS.DEFAULT_THEME_ID_LIGHT,
      THEME_BOOT_PLACEHOLDERS.DEFAULT_THEME_ID_DARK,
    ].join(' ')

    expect(injectThemeBootDefaults(html)).toBe(
      [
        JSON.stringify(THEME_STORAGE_KEY),
        JSON.stringify(THEME_STORAGE_KEY),
        JSON.stringify(DEFAULT_THEME_ID_LIGHT),
        JSON.stringify(DEFAULT_THEME_ID_DARK),
      ].join(' '),
    )
  })

  // A mismatched/renamed token used to be a silent split/join no-op: the
  // build would ship a bare `__KM_..._` identifier and the pre-paint IIFE's
  // try/catch would swallow the resulting ReferenceError with zero signal.
  // These mirror scripts/stamp-sw-source.test.ts's "throws when a
  // placeholder is absent" coverage.
  it.each([
    ['storage key', THEME_BOOT_PLACEHOLDERS.THEME_STORAGE_KEY],
    ['light theme id', THEME_BOOT_PLACEHOLDERS.DEFAULT_THEME_ID_LIGHT],
    ['dark theme id', THEME_BOOT_PLACEHOLDERS.DEFAULT_THEME_ID_DARK],
  ])('throws when the %s placeholder is absent', (_label, missingToken) => {
    const html = Object.values(THEME_BOOT_PLACEHOLDERS)
      .filter(token => token !== missingToken)
      .join(' ')

    expect(() => injectThemeBootDefaults(html)).toThrow(new RegExp(`${missingToken} not found`))
  })

  it('throws when an unmapped __KM_ token survives substitution', () => {
    const html = `${THEME_BOOT_PLACEHOLDERS.THEME_STORAGE_KEY} ${THEME_BOOT_PLACEHOLDERS.DEFAULT_THEME_ID_LIGHT} ${THEME_BOOT_PLACEHOLDERS.DEFAULT_THEME_ID_DARK} __KM_SOME_NEW_TOKEN__`

    expect(() => injectThemeBootDefaults(html)).toThrow(/__KM_SOME_NEW_TOKEN__/)
  })

  // Reads the real index.html (not a hand-built fixture) so a future
  // index.html/constants drift — a renamed or newly added __KM_ token with
  // no matching replacements entry — fails here, in `pnpm run check`, rather
  // than only surfacing at a real `vite build`. Not asserting a blunt
  // `not.toContain('__KM_')`: index.html's own pre-paint comment legitimately
  // says "The __KM_..._ tokens below are generated…" in prose, which contains
  // that substring without being a real placeholder. The actual drift guard
  // is `injectThemeBootDefaults` itself throwing whenever a real
  // `__KM_..._`-shaped token survives substitution — not throwing here,
  // combined with the known values showing up, is the signal.
  it('substitutes every real __KM_ token in the real index.html', () => {
    const indexHtmlPath = fileURLToPath(new URL('../../index.html', import.meta.url))
    const html = readFileSync(indexHtmlPath, 'utf8')

    const rewritten = injectThemeBootDefaults(html)

    expect(rewritten).toContain(JSON.stringify(THEME_STORAGE_KEY))
    expect(rewritten).toContain(JSON.stringify(DEFAULT_THEME_ID_LIGHT))
    expect(rewritten).toContain(JSON.stringify(DEFAULT_THEME_ID_DARK))
  })
})
