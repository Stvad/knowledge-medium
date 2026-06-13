import { actionsFacet, appEffectsFacet } from '@/extensions/core.js'
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.js'
import { themeStyleSyncEffect } from './effect.ts'
import { toggleTheme } from './theme.ts'

export { ThemeToggle } from './ThemeToggle.tsx'
export {
  applyTheme,
  FALLBACK_THEME,
  getCurrentTheme,
  getThemes,
  setThemeRegistry,
  themesFacet,
  toggleTheme,
  THEME_STORAGE_KEY,
  type ThemeContribution,
  type ThemeDefinition,
} from './theme.ts'
export { themeStyleSyncEffect } from './effect.ts'

export const toggleThemeAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: 'theme-toggle.toggle',
  description: 'Cycle through themes',
  context: ActionContextTypes.GLOBAL,
  handler: () => {
    toggleTheme()
  },
}

export const themeTogglePlugin: AppExtension = systemToggle({
  id: 'system:theme-toggle',
  name: 'Theme toggle',
  description: 'Cycle through the registered colour themes.',
}).of([
  actionsFacet.of(toggleThemeAction, {
    source: 'theme-toggle',
  }),
  appEffectsFacet.of(themeStyleSyncEffect, {
    source: 'theme-toggle',
  }),
])
