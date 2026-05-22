import { blockChildrenFooterFacet } from '@/extensions/blockInteraction.js'
import { pluginPrefsExtension } from '@/data/pluginStateExtensions.js'
import type { AppExtension } from '@/extensions/facet.js'
import { systemToggle } from '@/extensions/togglable.js'
import { backlinksViewFooterContribution } from './BacklinksViewSection.tsx'
import { backlinksViewPrefsType } from './prop.ts'

// Public extension points (`backlinksViewFacet`, `backlinksViewProp`)
// live in `./facet.ts` / `./prop.ts` and are imported directly by
// callers — keeping them out of this barrel keeps the plugin entry
// minimal and avoids forcing a JSX file via re-exports.
export const backlinksViewPlugin: AppExtension = systemToggle({
  id: 'system:backlinks-view',
  name: 'Backlinks view',
  description: 'Picker that switches between the flat and grouped backlinks renderings.',
}).of([
  blockChildrenFooterFacet.of(backlinksViewFooterContribution, {source: 'backlinks-view'}),
  ...pluginPrefsExtension(backlinksViewPrefsType, 'backlinks-view'),
])
