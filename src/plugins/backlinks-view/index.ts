import { blockChildrenFooterFacet } from '@/extensions/blockInteraction.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { backlinksViewFooterContribution } from './BacklinksViewSection.tsx'

// Public extension points (`backlinksViewFacet`, `backlinksViewProp`)
// live in `./facet.ts` / `./prop.ts` and are imported directly by
// callers — keeping them out of this barrel keeps the plugin entry
// minimal and avoids forcing a JSX file via re-exports.
export const backlinksViewPlugin: AppExtension = [
  blockChildrenFooterFacet.of(backlinksViewFooterContribution, {source: 'backlinks-view'}),
]
