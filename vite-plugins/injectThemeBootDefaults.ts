import type {Plugin} from 'vite'
import {
  DEFAULT_THEME_ID_DARK,
  DEFAULT_THEME_ID_LIGHT,
  THEME_STORAGE_KEY,
} from '../src/themeBootDefaults.ts'

/**
 * Placeholder tokens the index.html pre-paint script embeds bare (as JS
 * expressions, not inside quotes) so substitution can drop in a
 * `JSON.stringify`-quoted literal directly — see index.html.
 */
export const THEME_BOOT_PLACEHOLDERS = {
  THEME_STORAGE_KEY: '__KM_THEME_STORAGE_KEY__',
  DEFAULT_THEME_ID_LIGHT: '__KM_DEFAULT_THEME_ID_LIGHT__',
  DEFAULT_THEME_ID_DARK: '__KM_DEFAULT_THEME_ID_DARK__',
} as const

const replacements: ReadonlyArray<readonly [string, string]> = [
  [THEME_BOOT_PLACEHOLDERS.THEME_STORAGE_KEY, JSON.stringify(THEME_STORAGE_KEY)],
  [THEME_BOOT_PLACEHOLDERS.DEFAULT_THEME_ID_LIGHT, JSON.stringify(DEFAULT_THEME_ID_LIGHT)],
  [THEME_BOOT_PLACEHOLDERS.DEFAULT_THEME_ID_DARK, JSON.stringify(DEFAULT_THEME_ID_DARK)],
]

// Any `__KM_..._`-shaped token left in the output after substitution — a
// renamed/typo'd placeholder, or a new token added to index.html without a
// matching `replacements` entry. Kept broad (not the three known names) so
// it also catches FUTURE tokens nobody wired up yet.
const LEFTOVER_TOKEN = /__KM_[A-Za-z0-9_]*__/g

/**
 * Substitutes the `__KM_..._`-token placeholders in index.html's pre-paint
 * script with the current THEME_STORAGE_KEY / DEFAULT_THEME_ID_LIGHT /
 * DEFAULT_THEME_ID_DARK values (src/themeBootDefaults.ts), so the
 * hand-duplicated literals that used to live in index.html can't drift
 * from the source of truth the app itself uses.
 *
 * A plain split/join (not a single combined regex) keeps each token's
 * replacement independent and unambiguous even if a substituted value
 * were ever to contain another token's text.
 *
 * Throws — so a mismatched/renamed token fails the build loudly instead of
 * shipping a bare `__KM_..._` identifier into the pre-paint IIFE (whose
 * try/catch would otherwise swallow the resulting ReferenceError with zero
 * signal, silently falling back to the wrong theme) — if an expected token
 * is missing from the input, or if any `__KM_..._` token survives the
 * substitution. Mirrors scripts/stamp-sw-source.ts.
 */
export const injectThemeBootDefaults = (html: string): string => {
  for (const [token] of replacements) {
    if (!html.includes(token)) throw new Error(`placeholder ${token} not found in index.html`)
  }

  const out = replacements.reduce((acc, [token, value]) => acc.split(token).join(value), html)

  const leftover = out.match(LEFTOVER_TOKEN)
  if (leftover) {
    throw new Error(`placeholder(s) survived injection: ${[...new Set(leftover)].join(', ')}`)
  }

  return out
}

/**
 * Runs via the `transformIndexHtml` hook, which Vite calls both for the
 * dev-server's per-request HTML transform and for the production build —
 * so `pnpm dev` and `pnpm build` stay in lockstep with no separate
 * dev/build code paths.
 */
export const injectThemeBootDefaultsPlugin = (): Plugin => ({
  name: 'inject-theme-boot-defaults',
  transformIndexHtml(html) {
    return injectThemeBootDefaults(html)
  },
})
