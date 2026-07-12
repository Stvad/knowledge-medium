import { propertyEditorOverridesFacet, valuePresetPresentationsFacet } from '@/data/facets.js'
import type { AppExtension } from '@/facets/facet.js'
import { backlinksViewFacet } from '@/plugins/backlinks-view/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { defineVariant } from '@/facets/variantFacet.js'
import {defineHiddenPresetPresentation} from '@/data/api'
import { GroupedLinkedReferences } from './GroupedLinkedReferences.tsx'
import { groupedBacklinksDataExtension } from './dataExtension.ts'
import { groupedBacklinksDefaultsUi } from './propertyEditorOverride.ts'
import {
  groupedBacklinksConfigPresetCore,
  groupedBacklinksOverridesPresetCore,
} from './config.ts'

// Registers a "Grouped" variant on the backlinks-view facet. The
// coordinator (backlinks-view plugin) decides when the variant
// actually mounts — top-level only, plus the user's saved choice.
export const groupedBacklinksPlugin: AppExtension = systemToggle({
  id: 'system:grouped-backlinks',
  name: 'Grouped backlinks',
  description: 'Backlinks grouped by a configurable property (defaults to the type of the source block).',
}).of([
  groupedBacklinksDataExtension,
  propertyEditorOverridesFacet.of(groupedBacklinksDefaultsUi, {source: 'grouped-backlinks'}),
  valuePresetPresentationsFacet.of(
    defineHiddenPresetPresentation(groupedBacklinksConfigPresetCore, 'Grouped-backlinks configuration'),
    {source: 'grouped-backlinks'},
  ),
  valuePresetPresentationsFacet.of(
    defineHiddenPresetPresentation(groupedBacklinksOverridesPresetCore, 'Grouped-backlinks overrides'),
    {source: 'grouped-backlinks'},
  ),
  backlinksViewFacet.of(
    () => defineVariant('grouped', 'Grouped', GroupedLinkedReferences),
    {source: 'grouped-backlinks'},
  ),
])
