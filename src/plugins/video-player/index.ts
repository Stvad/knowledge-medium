import {
  blockLayoutFacet,
  shortcutSurfaceActivationsFacet,
} from '@/extensions/blockInteraction.js'
import { blockRenderersFacet } from '@/extensions/core.js'
import { propertySchemasFacet } from '@/data/facets.js'
import { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { markdownExtensionsFacet } from '@/markdown/extensions.js'
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

export const videoPlayerPlugin: AppExtension = systemToggle({
  id: 'system:video-player',
  name: 'Video player',
  description: 'Inline playback for blocks whose content is a video URL.',
}).of([
  propertySchemasFacet.of(videoPlayerViewProp, {source: 'video-player'}),
  propertySchemasFacet.of(videoNotesPaneRatioProp, {source: 'video-player'}),
  blockRenderersFacet.of({id: 'videoPlayer', renderer: VideoPlayerRenderer}, {source: 'video-player'}),
  blockLayoutFacet.of(videoPlayerLayoutContribution, {source: 'video-player'}),
  markdownExtensionsFacet.of(videoPlayerMarkdownExtension, {source: 'video-player'}),
  shortcutSurfaceActivationsFacet.of(videoPlayerShortcutActivation, {source: 'video-player'}),
  videoPlayerActionsExtension,
])

export default videoPlayerPlugin
