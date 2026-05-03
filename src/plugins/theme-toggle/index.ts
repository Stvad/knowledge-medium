import { headerItemsFacet, type HeaderItemContribution } from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { ThemeToggle } from './ThemeToggle.tsx'

export { ThemeToggle } from './ThemeToggle.tsx'

export const themeToggleHeaderItem: HeaderItemContribution = {
  id: 'theme-toggle.header',
  region: 'end',
  component: ThemeToggle,
}

export const themeTogglePlugin: AppExtension = [
  headerItemsFacet.of(themeToggleHeaderItem, {
    source: 'theme-toggle',
    precedence: 40,
  }),
]
