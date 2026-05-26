/*
  Theme registry. The active theme is written to `data-theme` on the
  document root; the matching `[data-theme="<id>"]` block in src/index.css
  (for built-ins) or in a runtime-managed <style> element (for plugin
  contributions) supplies the palette. A pre-paint script in index.html
  reads the persisted value before React mounts to avoid a flash of the
  default palette on reload.

  Plugins register themes via `themesFacet.of(...)` — see
  `ThemeContribution` below. The theme-toggle plugin's effect mirrors
  those contributions into a managed <style> block and folds them into
  the cycle order so toggleTheme() cycles through them alongside the
  built-in light/dark.
*/

import { defineFacet } from '@/extensions/facet.js'

export interface ThemeDefinition {
  readonly id: string
  readonly label: string
  readonly mode: 'light' | 'dark'
}

/** A plugin-contributed theme. `tokens` maps CSS variable names (no
 *  `--` prefix) to HSL value strings, e.g. `{ background: '249 22% 12%',
 *  foreground: '245 50% 91%', ... }`. The full set of recommended
 *  tokens lives in src/index.css; omitting one leaves it inheriting the
 *  `:root` (light) default for that token, which can produce
 *  half-light/half-dark palettes — pass a complete set to avoid
 *  surprises. */
export interface ThemeContribution extends ThemeDefinition {
  readonly tokens: Readonly<Record<string, string>>
}

const isThemeContribution = (value: unknown): value is ThemeContribution => {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<ThemeContribution>
  return (
    typeof v.id === 'string' &&
    typeof v.label === 'string' &&
    (v.mode === 'light' || v.mode === 'dark') &&
    !!v.tokens &&
    typeof v.tokens === 'object'
  )
}

export const themesFacet = defineFacet<ThemeContribution, readonly ThemeContribution[]>({
  id: 'theme-toggle.themes',
  validate: isThemeContribution,
})

export const BUILTIN_THEMES: readonly ThemeDefinition[] = [
  { id: 'light', label: 'Light', mode: 'light' },
  { id: 'dark', label: 'Dark', mode: 'dark' },
] as const

// Mutable registry — the cycle order. Built-ins are present from
// module load; the theme-toggle effect overwrites this on facet
// changes to fold in plugin contributions. Outside callers should
// read via `getThemes()`.
let registry: readonly ThemeDefinition[] = BUILTIN_THEMES
let registryById = new Map<string, ThemeDefinition>(
  BUILTIN_THEMES.map((t) => [t.id, t]),
)

export const getThemes = (): readonly ThemeDefinition[] => registry

/** Used by the theme-toggle effect. Plugins should not call this
 *  directly — contribute via `themesFacet.of(...)` instead. */
export const setThemeRegistry = (next: readonly ThemeDefinition[]): void => {
  registry = next
  registryById = new Map(next.map((t) => [t.id, t]))
}

export const THEME_STORAGE_KEY = 'theme'

const getDocumentRoot = (): HTMLElement => window.document.documentElement

const resolveTheme = (theme: ThemeDefinition | string): ThemeDefinition =>
  typeof theme === 'string' ? registryById.get(theme) ?? registry[0] : theme

export const getCurrentTheme = (
  root: HTMLElement = getDocumentRoot(),
): ThemeDefinition => registryById.get(root.dataset.theme ?? '') ?? registry[0]

export const applyTheme = (
  theme: ThemeDefinition | string,
  root: HTMLElement = getDocumentRoot(),
): ThemeDefinition => {
  const resolved = resolveTheme(theme)
  root.dataset.theme = resolved.id
  try {
    window.localStorage?.setItem(THEME_STORAGE_KEY, resolved.id)
  } catch {
    // Storage may be unavailable (private mode, embedded contexts) —
    // the visual switch still takes effect; persistence is best-effort.
  }
  return resolved
}

export const toggleTheme = (
  root: HTMLElement = getDocumentRoot(),
): ThemeDefinition => {
  const current = getCurrentTheme(root)
  const idx = registry.findIndex((t) => t.id === current.id)
  const next = registry[(idx + 1) % registry.length]
  return applyTheme(next, root)
}
