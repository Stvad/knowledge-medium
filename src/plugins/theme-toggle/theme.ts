/*
  Theme registry. The active theme is written to `data-theme` on the
  document root; the matching `[data-theme="<id>"]` block in src/index.css
  supplies the palette. A pre-paint script in index.html reads the
  persisted value before React mounts to avoid a flash of the default
  palette on reload.

  To add a theme: append a `ThemeDefinition` entry below and a matching
  `[data-theme="<id>"]` CSS block. The `mode` field drives the sun/moon
  icon and lets future code pick a default for `prefers-color-scheme`.
*/

export interface ThemeDefinition {
  readonly id: string
  readonly label: string
  readonly mode: 'light' | 'dark'
}

export const themes: readonly ThemeDefinition[] = [
  { id: 'light', label: 'Light', mode: 'light' },
  { id: 'dark', label: 'Dark', mode: 'dark' },
] as const

export const THEME_STORAGE_KEY = 'theme'

const themesById: ReadonlyMap<string, ThemeDefinition> = new Map(
  themes.map((theme) => [theme.id, theme]),
)

const getDocumentRoot = (): HTMLElement => window.document.documentElement

const resolveTheme = (theme: ThemeDefinition | string): ThemeDefinition =>
  typeof theme === 'string' ? themesById.get(theme) ?? themes[0] : theme

export const getCurrentTheme = (
  root: HTMLElement = getDocumentRoot(),
): ThemeDefinition => themesById.get(root.dataset.theme ?? '') ?? themes[0]

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
  const idx = themes.findIndex((theme) => theme.id === current.id)
  const next = themes[(idx + 1) % themes.length]
  return applyTheme(next, root)
}
