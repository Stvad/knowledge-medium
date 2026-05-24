/** Geo plugin — physical-world location references. See the project
 *  plan at [.claude/plans/compiled-wobbling-kahan.md] for the full
 *  design.
 *
 *  Composes its dependencies (currently `referencesPlugin`) directly
 *  into its `AppExtension` array. Facet-level dedup means listing the
 *  same dependency in `staticAppExtensions` is harmless — order is
 *  irrelevant. */

import { propertyEditorOverridesFacet } from '@/data/facets'
import { blockRenderersFacet } from '@/extensions/core'
import type { AppExtension } from '@/extensions/facet'
import { systemToggle } from '@/extensions/togglable'
import { referencesPlugin } from '@/plugins/references'
import { geoDataExtension } from './dataExtension'
import { LocationsPageBlockRenderer } from './LocationsPageBlockRenderer'
import { locationPropertyEditorOverride } from './propertyEditorOverrides'

export const geoPlugin: AppExtension = systemToggle({
  id: 'system:geo',
  name: 'Locations',
  description: 'Physical-world location references — Place blocks, @ autocomplete, and map views.',
}).of([
  // Dependency chain: the @ autocomplete inserts [[Name]] wikilinks
  // which the references plugin parses. Including it here means we
  // don't depend on registration order in staticAppExtensions.
  referencesPlugin,
  geoDataExtension,
  blockRenderersFacet.of({
    id: 'geo:locationsPage',
    renderer: LocationsPageBlockRenderer,
  }, {source: 'geo'}),
  propertyEditorOverridesFacet.of(locationPropertyEditorOverride, {source: 'geo'}),
])
