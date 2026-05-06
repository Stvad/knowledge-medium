import {
  blockLayoutFacet,
  shortcutSurfaceActivationsFacet,
} from '@/extensions/blockInteraction.ts'
import { blockRenderersFacet } from '@/extensions/core.ts'
import { propertySchemasFacet } from '@/data/facets.ts'
import { AppExtension } from '@/extensions/facet.ts'
import { markdownExtensionsFacet } from '@/markdown/extensions.ts'
import {
  videoPlayerActionsExtension,
  videoPlayerShortcutActivation,
} from './actions.ts'
import {
  VideoPlayerRenderer,
  videoPlayerLayoutContribution,
} from './VideoPlayerRenderer.tsx'
import { videoPlayerMarkdownExtension } from './markdown.tsx'
import { videoNotesPaneRatioProp, videoPlayerViewProp } from './view.ts'

export const videoPlayerPlugin: AppExtension = [
  propertySchemasFacet.of(videoPlayerViewProp, {source: 'video-player'}),
  propertySchemasFacet.of(videoNotesPaneRatioProp, {source: 'video-player'}),
  blockRenderersFacet.of({id: 'videoPlayer', renderer: VideoPlayerRenderer}, {source: 'video-player'}),
  blockLayoutFacet.of(videoPlayerLayoutContribution, {source: 'video-player'}),
  markdownExtensionsFacet.of(videoPlayerMarkdownExtension, {source: 'video-player'}),
  shortcutSurfaceActivationsFacet.of(videoPlayerShortcutActivation, {source: 'video-player'}),
  videoPlayerActionsExtension,
]
