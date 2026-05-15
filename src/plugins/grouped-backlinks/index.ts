import { propertyEditorOverridesFacet } from '@/data/facets.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { backlinksViewFacet } from '@/plugins/backlinks-view/facet.ts'
import { defineVariant } from '@/extensions/variantFacet.ts'
import { GroupedLinkedReferences } from './GroupedLinkedReferences.tsx'
import { groupedBacklinksDataExtension } from './dataExtension.ts'
import { groupedBacklinksDefaultsUi } from './propertyEditorOverride.ts'

// Registers a "Grouped" variant on the backlinks-view facet. The
// coordinator (backlinks-view plugin) decides when the variant
// actually mounts — top-level only, plus the user's saved choice.
export const groupedBacklinksPlugin: AppExtension = [
  groupedBacklinksDataExtension,
  propertyEditorOverridesFacet.of(groupedBacklinksDefaultsUi, {source: 'grouped-backlinks'}),
  backlinksViewFacet.of(
    () => defineVariant('grouped', 'Grouped', GroupedLinkedReferences),
    {source: 'grouped-backlinks'},
  ),
]
