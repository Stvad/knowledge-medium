import { blockChildrenFooterFacet } from '@/extensions/blockInteraction.js'
import { propertySchemasFacet } from '@/data/facets.js'
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { backlinksViewFooterContribution } from './BacklinksViewSection.tsx'
import { backlinksViewProp } from './prop.ts'

// Public extension points (`backlinksViewFacet`, `backlinksViewProp`)
// live in `./facet.ts` / `./prop.ts` and are imported directly by
// callers — keeping them out of this barrel keeps the plugin entry
// minimal and avoids forcing a JSX file via re-exports.
export const backlinksViewPlugin: AppExtension = systemToggle({
  id: 'system:backlinks-view',
  name: 'Backlinks view',
  description: 'Picker that switches each block between the flat and grouped backlinks renderings.',
}).of([
  propertySchemasFacet.of(backlinksViewProp, {source: 'backlinks-view'}),
  blockChildrenFooterFacet.of(backlinksViewFooterContribution, {source: 'backlinks-view'}),
])

export default backlinksViewPlugin
