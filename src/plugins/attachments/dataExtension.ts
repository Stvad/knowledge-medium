import { attachmentCleanerIOVerb } from '@/data/attachmentCleanerIOVerb.js'
import { definitionSeedsFacet, systemPagesFacet, typeSeedsFacet } from '@/data/facets.js'
import type { AppExtension } from '@/facets/facet.js'
import {
  ASSETS_TYPE_CONTRIBUTION,
  assetsPageSpec,
  MEDIA_PROPERTY_SCHEMAS,
  MEDIA_TYPE_CONTRIBUTION,
} from './mediaBlock.js'

export const attachmentCleanerIOContribution = attachmentCleanerIOVerb.impl(
  // Loaded when asked for: the data runtime's extensions are imported by the
  // repo provider itself, which the IO's Storage and byte store depend on.
  async ({repo, workspaceId}) => (await import('./cleanerIO.js')).cleanerIOFor(repo, workspaceId),
  {source: 'attachments'},
)

/** In the data runtime as well as the plugin's: the conversion flow runs from
 *  the workspace gate, where no app runtime has been installed yet, and a
 *  headless host captures media blocks with the data runtime alone. */
export const attachmentsDataExtension: AppExtension = [
  typeSeedsFacet.of(MEDIA_TYPE_CONTRIBUTION, {source: 'attachments'}),
  typeSeedsFacet.of(ASSETS_TYPE_CONTRIBUTION, {source: 'attachments'}),
  MEDIA_PROPERTY_SCHEMAS.map(schema => definitionSeedsFacet.of(schema, {source: 'attachments'})),
  systemPagesFacet.of({spec: assetsPageSpec, eager: false}, {source: 'attachments'}),
  attachmentCleanerIOContribution,
]
