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

import { defineFacet } from '@/facets/facet.js'

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

/** Bootstrap sentinel. Used only when the registry is otherwise
 *  empty (the few hundred ms between module load and the style-sync
 *  effect mounting). Matches the `:root` palette in src/index.css
 *  so the visual identity stays consistent during that window. The
 *  default-themes plugin contributes a `sunset-warm-light` theme of
 *  its own once it loads; from then on this entry is unreferenced. */
export const FALLBACK_THEME: ThemeDefinition = {
  id: 'sunset-warm-light',
  label: 'Sunset Warm Light',
  mode: 'light',
}

// Mutable registry — the cycle order. The style-sync effect
// overwrites this on facet changes to mirror plugin contributions.
// Outside callers should read via `getThemes()`.
let registry: readonly ThemeDefinition[] = [FALLBACK_THEME]
let registryById = new Map<string, ThemeDefinition>([
  [FALLBACK_THEME.id, FALLBACK_THEME],
])

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
  typeof theme === 'string'
    ? registryById.get(theme) ?? registry[0] ?? FALLBACK_THEME
    : theme

export const getCurrentTheme = (
  root: HTMLElement = getDocumentRoot(),
): ThemeDefinition =>
  registryById.get(root.dataset.theme ?? '') ?? registry[0] ?? FALLBACK_THEME

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
  if (registry.length === 0) return applyTheme(FALLBACK_THEME, root)
  const current = getCurrentTheme(root)
  const idx = registry.findIndex((t) => t.id === current.id)
  // findIndex returns -1 when the current id isn't registered (e.g. a
  // persisted plugin theme that's no longer loaded). Treat that as
  // "start from the top" so the first toggle lands on registry[0]
  // rather than wrapping past the end.
  const next = registry[(idx + 1) % registry.length]
  return applyTheme(next, root)
}
