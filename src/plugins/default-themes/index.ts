import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { themesFacet } from '@/plugins/theme-toggle'
import { defaultThemeContributions } from './themes.ts'

export {
  defaultThemeContributions,
  DEFAULT_THEME_ID_LIGHT,
  DEFAULT_THEME_ID_DARK,
} from './themes.ts'

export const defaultThemesPlugin: AppExtension = systemToggle({
  id: 'system:default-themes',
  name: 'Default themes',
  description:
    'Bundles the built-in colour palettes (light, dark, sunset, indigo, solarized). Disabling falls back to the bootstrap palette only.',
}).of(
  defaultThemeContributions.map((theme) =>
    themesFacet.of(theme, { source: 'default-themes' }),
  ),
)

export default defaultThemesPlugin
