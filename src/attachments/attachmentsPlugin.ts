/**
 * The `attachments` plugin (design §11) — packages the media block model + its
 * renderer, mirroring the video-player plugin's facet wiring.
 *
 * Phase 4 scope: the `media` block TYPE + its property schemas (typesFacet /
 * propertySchemasFacet) and the {@link MediaBlockRenderer} (blockRenderersFacet,
 * `canRender = block.hasType('media')`). Capture (paste/drop, §9) and the
 * background up/down lanes arrive in later phases; the bytes seam (§5), storage
 * (§10), and the resolver (§7.3) already exist underneath.
 */

import { propertySchemasFacet, typesFacet } from '@/data/facets.js'
import { blockRenderersFacet } from '@/extensions/core.js'
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { MediaBlockRenderer } from './MediaBlockRenderer.js'
import { MEDIA_PROPERTY_SCHEMAS, MEDIA_TYPE_CONTRIBUTION } from './mediaBlock.js'

export const attachmentsPlugin: AppExtension = systemToggle({
  id: 'system:attachments',
  name: 'Attachments',
  description: 'Image & file attachments — content-addressed media blocks embedded via !((id)).',
}).of([
  typesFacet.of(MEDIA_TYPE_CONTRIBUTION, { source: 'attachments' }),
  MEDIA_PROPERTY_SCHEMAS.map((schema) => propertySchemasFacet.of(schema, { source: 'attachments' })),
  blockRenderersFacet.of({ id: 'media', renderer: MediaBlockRenderer }, { source: 'attachments' }),
])
