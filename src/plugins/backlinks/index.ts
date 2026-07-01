import { AppExtension } from '@/facets/facet.js'
import { propertyEditorOverridesFacet } from '@/data/facets.js'
import { backlinksViewFacet } from '@/plugins/backlinks-view/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { defineVariant } from '@/facets/variantFacet.js'
import { LinkedReferences } from './LinkedReferences.tsx'
import { backlinksDataExtension } from './dataExtension.ts'
import { dailyNoteBacklinksDefaultsUi } from './propertyEditorOverride.ts'
import { backlinkBreadcrumbShortcutsExtension } from './backlinkBreadcrumbShortcuts.ts'
import { inlineBacklinkCountsExtension } from './inline-counts/index.ts'

// Show "Linked References" only when the block is the zoom-in target. Roam-
// style: backlinks live with the page you're viewing, not inline beside every
// nested bullet. The top-level gate is enforced by the backlinks-view
// coordinator's footer contribution; this variant always offers itself.
// The nested `inlineBacklinkCountsExtension` sub-toggle relaxes that: it adds
// a per-block reference-count badge that expands the same flat list inline.
export const backlinksPlugin: AppExtension = systemToggle({
  id: 'system:backlinks',
  name: 'Backlinks',
  description: 'Flat list of incoming references to the focused block.',
}).of([
  backlinksDataExtension,
  backlinkBreadcrumbShortcutsExtension,
  propertyEditorOverridesFacet.of(dailyNoteBacklinksDefaultsUi, {source: 'backlinks'}),
  backlinksViewFacet.of(
    () => defineVariant('flat', 'Flat', LinkedReferences),
    {source: 'backlinks'},
  ),
  inlineBacklinkCountsExtension,
])

export default backlinksPlugin
