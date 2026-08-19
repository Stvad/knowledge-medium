/*
  Single source of truth for the values the index.html pre-paint script
  needs before React (or any `@/`-aliased module) is available: the
  localStorage key the persisted theme lives under, and the ids to fall
  back to when nothing is persisted yet.

  This module is deliberately import-free (no `@/` aliases, no other
  project files) so it can be loaded two ways that don't share a module
  resolver:

    - by app code, via the normal Vite/TS path alias (`@/themeBootDefaults`)
    - by vite.config.ts (through vite-plugins/injectThemeBootDefaults.ts),
      which runs as a plain Node/esbuild-bundled script outside the app's
      module graph and can only follow relative imports

  src/plugins/theme-toggle/theme.ts re-exports THEME_STORAGE_KEY and
  src/plugins/default-themes/themes.ts re-exports DEFAULT_THEME_ID_LIGHT /
  _DARK (and uses them as the literal `id`s of its SUNSET_WARM_LIGHT /
  _DARK contributions), so each constant still has exactly one place to
  edit. vite-plugins/injectThemeBootDefaults.ts substitutes them into the
  index.html pre-paint script at build/dev time — see that file and the
  script comment in index.html.
*/

export const THEME_STORAGE_KEY = 'theme'

/** The theme id pre-paint falls back to when nothing is persisted and the
 *  system preference is "light" (or unavailable). */
export const DEFAULT_THEME_ID_LIGHT = 'sunset-warm-light'

/** The theme id pre-paint falls back to when nothing is persisted and the
 *  system preference is "dark". */
export const DEFAULT_THEME_ID_DARK = 'sunset-warm-dark'
