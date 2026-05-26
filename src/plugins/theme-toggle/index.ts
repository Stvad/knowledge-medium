import { actionsFacet } from '@/extensions/core.js'
import type { AppExtension } from '@/extensions/facet.js'
import { systemToggle } from '@/extensions/togglable.js'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.js'
import { toggleTheme } from './theme.ts'

export { ThemeToggle } from './ThemeToggle.tsx'
export {
  applyTheme,
  getCurrentTheme,
  themes,
  toggleTheme,
  THEME_STORAGE_KEY,
  type ThemeDefinition,
} from './theme.ts'

export const toggleThemeAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: 'theme-toggle.toggle',
  description: 'Toggle theme',
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
])
