/** Geo plugin — physical-world location references. See the project
 *  plan at [.claude/plans/compiled-wobbling-kahan.md] for the full
 *  design.
 *
 *  Composes its dependencies (currently `referencesPlugin`) directly
 *  into its `AppExtension` array. Facet-level dedup means listing the
 *  same dependency in `staticAppExtensions` is harmless — order is
 *  irrelevant. */

import { propertyEditorOverridesFacet } from '@/data/facets'
import { codeMirrorExtensionsFacet } from '@/extensions/editor'
import { blockContentDecoratorsFacet } from '@/extensions/blockInteraction.js'
import type { AppExtension } from '@/facets/facet'
import { systemToggle } from '@/facets/togglable'
import { referencesPlugin } from '@/plugins/references'
import { geoDataExtension } from './dataExtension'
import { geoCodeMirrorExtensions } from './codeMirrorExtensions'
import { geoContentDecoratorContribution } from './geoContentDecorator'
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
  // CodeMirror surface (theme + `@` completion) — editor UI, kept out of
  // dataExtension to keep the data/UI split clean.
  codeMirrorExtensionsFacet.of(geoCodeMirrorExtensions, {source: 'geo'}),
  blockContentDecoratorsFacet.of(geoContentDecoratorContribution, {source: 'geo'}),
  propertyEditorOverridesFacet.of(locationPropertyEditorOverride, {source: 'geo'}),
])

export default geoPlugin
