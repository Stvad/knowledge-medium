/*
  Theme registry. The active theme is written to `data-theme` on the
  document root; the matching `[data-theme="<id>"]` block in src/index.css
  (for built-ins) or in a runtime-managed <style> element (for plugin
  contributions) supplies the palette. Its mode goes beside it as
  `data-theme-mode`, which Tailwind's `dark:` variant keys on. A pre-paint
  script in index.html reads both persisted values before React mounts to
  avoid a flash of the default palette on reload.

  Plugins register themes via `themesFacet.of(...)` — see
  `ThemeContribution` below. The theme-toggle plugin's effect mirrors
  those contributions into a managed <style> block and folds them into
  the cycle order so toggleTheme() cycles through them alongside the
  built-in light/dark.
*/

import { defineFacet } from '@/facets/facet.js'
import { THEME_MODE_STORAGE_KEY, THEME_STORAGE_KEY } from '@/themeBootDefaults.js'

export type ThemeMode = 'light' | 'dark'

export interface ThemeDefinition {
  readonly id: string
  readonly label: string
  readonly mode: ThemeMode
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
 *  directly — contribute via `themesFacet.of(...)` instead.
 *
 *  NOTE: this is the "module-global mirror synced by an app effect"
 *  pattern. `processorRejectionToast` now reads `repo.facetRuntime`
 *  directly instead of mirroring; converging this registry onto that read
 *  is deferred to the runtime-composition work. */
export const setThemeRegistry = (next: readonly ThemeDefinition[]): void => {
  registry = next
  registryById = new Map(next.map((t) => [t.id, t]))
}

export { THEME_MODE_STORAGE_KEY, THEME_STORAGE_KEY }

const getDocumentRoot = (): HTMLElement => window.document.documentElement

const resolveTheme = (theme: ThemeDefinition | string): ThemeDefinition =>
  typeof theme === 'string'
    ? registryById.get(theme) ?? registry[0] ?? FALLBACK_THEME
    : theme

export const getCurrentTheme = (
  root: HTMLElement = getDocumentRoot(),
): ThemeDefinition =>
  registryById.get(root.dataset.theme ?? '') ?? registry[0] ?? FALLBACK_THEME

/** Writes the live theme's root attributes. An absent mode clears the
 *  attribute, so `dark:` falls back to light, as the `:root` palette does. */
const setLiveTheme = (
  id: string,
  mode: ThemeMode | undefined,
  root: HTMLElement,
): void => {
  root.dataset.theme = id
  if (mode) root.dataset.themeMode = mode
  else delete root.dataset.themeMode
}

/** Persists a chosen theme for the pre-paint script. A theme that is not
 *  persisted keeps following the system preference on each load. */
const persistTheme = (id: string, mode: ThemeMode | undefined): void => {
  try {
    window.localStorage?.setItem(THEME_STORAGE_KEY, id)
    if (mode) window.localStorage?.setItem(THEME_MODE_STORAGE_KEY, mode)
    else window.localStorage?.removeItem(THEME_MODE_STORAGE_KEY)
  } catch {
    // Storage may be unavailable (private mode, embedded contexts) —
    // the visual switch still takes effect; persistence is best-effort.
  }
}

const persistedThemeId = (): string | null => {
  try {
    return window.localStorage?.getItem(THEME_STORAGE_KEY) ?? null
  } catch {
    return null
  }
}

export const applyTheme = (
  theme: ThemeDefinition | string,
  root: HTMLElement = getDocumentRoot(),
): ThemeDefinition => {
  const resolved = resolveTheme(theme)
  setLiveTheme(resolved.id, resolved.mode, root)
  persistTheme(resolved.id, resolved.mode)
  return resolved
}

/** Applies `id` verbatim, unlike `applyTheme`, which swaps an unregistered
 *  id for the first registered theme. An id the registry doesn't know yet
 *  gets no mode until `syncLiveThemeMode` sees it register. */
export const applyThemeId = (
  id: string,
  root: HTMLElement = getDocumentRoot(),
): void => {
  const mode = registryById.get(id)?.mode
  setLiveTheme(id, mode, root)
  persistTheme(id, mode)
}

/** Re-stamps the live theme's mode from the registry, for an id that was
 *  set before it registered (pre-paint, `applyThemeId`). Persists the mode
 *  only beside the same persisted id, so it never turns pre-paint's
 *  system-preference default into a chosen theme or overwrites another
 *  tab's newer choice.
 *
 *  Leaves an unregistered live id alone, for the birthday wolf theme's own
 *  dark palette. Accepted: a persisted dark theme whose plugin is gone
 *  keeps its dark mode over the light `:root` palette until a theme is
 *  picked. */
export const syncLiveThemeMode = (root: HTMLElement = getDocumentRoot()): void => {
  const live = registryById.get(root.dataset.theme ?? '')
  if (!live) return
  setLiveTheme(live.id, live.mode, root)
  if (persistedThemeId() === live.id) persistTheme(live.id, live.mode)
}

export const toggleTheme = (
  root: HTMLElement = getDocumentRoot(),
): ThemeDefinition => {
  if (registry.length === 0) return applyTheme(FALLBACK_THEME, root)
  // getCurrentTheme maps an unregistered live id (a persisted plugin theme
  // that's no longer loaded) to registry[0], whose look the `:root` palette
  // gives it, so the first toggle moves on to registry[1].
  const current = getCurrentTheme(root)
  const idx = registry.findIndex((t) => t.id === current.id)
  const next = registry[(idx + 1) % registry.length]
  return applyTheme(next, root)
}
