/**
 * The `attachments` plugin (design §11) — packages the media block model + its
 * renderer, mirroring the video-player plugin's facet wiring.
 *
 * Scope: the `media` block TYPE + its property schemas (typesFacet /
 * propertySchemasFacet), the {@link MediaBlockRenderer} (blockRenderersFacet), the
 * boot upload reconciler (appMountsFacet), and the paste rule that turns a file paste
 * into a media capture (pasteDecisionVerb decorator). Everything the feature adds is
 * gated on this one toggle — disable it and a file paste falls through to a text
 * paste, no media blocks are minted, and the renderer/reconciler aren't mounted.
 */

import { propertySchemasFacet, typesFacet } from '@/data/facets.js'
import { appMountsFacet, blockRenderersFacet } from '@/extensions/core.js'
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { MediaBlockRenderer } from './MediaBlockRenderer.js'
import { MediaUploadReconciler } from './MediaUploadReconciler.js'
import { captureMediaContribution, mediaPasteDecisionContribution } from './pasteCapture.js'
import {
  ASSETS_TYPE_CONTRIBUTION,
  MEDIA_PROPERTY_SCHEMAS,
  MEDIA_TYPE_CONTRIBUTION,
} from './mediaBlock.js'

export const attachmentsPlugin: AppExtension = systemToggle({
  id: 'system:attachments',
  name: 'Attachments',
  description: 'Image & file attachments — content-addressed media blocks embedded via !((id)).',
}).of([
  typesFacet.of(MEDIA_TYPE_CONTRIBUTION, { source: 'attachments' }),
  typesFacet.of(ASSETS_TYPE_CONTRIBUTION, { source: 'attachments' }),
  MEDIA_PROPERTY_SCHEMAS.map((schema) => propertySchemasFacet.of(schema, { source: 'attachments' })),
  blockRenderersFacet.of({ id: 'media', renderer: MediaBlockRenderer }, { source: 'attachments' }),
  // The capture path: DECIDE a file paste is media (decorator) + ACT on it (the
  // captureMediaVerb impl). Both gated here, so disabling the plugin disables capture
  // (a file paste falls through to a text paste, and the verb is a no-op).
  mediaPasteDecisionContribution,
  captureMediaContribution,
  // Boot recovery for crashed captures (§9) — gated on initial-sync settle.
  appMountsFacet.of({ id: 'attachments.upload-reconciler', component: MediaUploadReconciler }, { source: 'attachments' }),
])
