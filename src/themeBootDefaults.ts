/*
  Single source of truth for the values the index.html pre-paint script
  needs before React (or any `@/`-aliased module) is available: the
  localStorage keys the persisted theme and its mode live under, and the
  ids to fall back to when nothing is persisted yet.

  This module is deliberately import-free (no `@/` aliases, no other
  project files) so it can be loaded two ways that don't share a module
  resolver:

    - by app code, via the normal Vite/TS path alias (`@/themeBootDefaults`)
    - by vite.config.ts (through vite-plugins/injectThemeBootDefaults.ts),
      which runs as a plain Node/esbuild-bundled script outside the app's
      module graph and can only follow relative imports

  The app's TypeScript imports these constants rather than repeating their
  values, so each has one place to edit (src/index.css's early-paint block
  repeats the dark id, since CSS can't import it). vite-plugins/injectThemeBootDefaults.ts
  substitutes them into the index.html pre-paint script at build/dev time —
  see that file and the script comment in index.html.
*/

export const THEME_STORAGE_KEY = 'theme'

/** The localStorage key the persisted theme's mode (`light` / `dark`)
 *  lives under, so pre-paint can set `data-theme-mode` before any theme
 *  registry exists. */
export const THEME_MODE_STORAGE_KEY = 'theme-mode'

/** The theme id pre-paint falls back to when nothing is persisted and the
 *  system preference is "light" (or unavailable). */
export const DEFAULT_THEME_ID_LIGHT = 'sunset-warm-light'

/** The theme id pre-paint falls back to when nothing is persisted and the
 *  system preference is "dark". */
export const DEFAULT_THEME_ID_DARK = 'sunset-warm-dark'
