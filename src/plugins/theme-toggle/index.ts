import { actionsFacet } from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { withSystemExtensionMetadata } from '@/extensions/togglable.ts'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.ts'
import { toggleTheme } from './theme.ts'

export { ThemeToggle } from './ThemeToggle.tsx'
export { applyTheme, getCurrentTheme, toggleTheme, type Theme } from './theme.ts'

export const toggleThemeAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: 'theme-toggle.toggle',
  description: 'Toggle theme',
  context: ActionContextTypes.GLOBAL,
  handler: () => {
    toggleTheme()
  },
}

export const themeTogglePlugin: AppExtension = withSystemExtensionMetadata({
  name: 'Theme toggle',
  description: 'Switch between light and dark colour scheme.',
}, [
  actionsFacet.of(toggleThemeAction, {
    source: 'theme-toggle',
  }),
])
