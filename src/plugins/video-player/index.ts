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
import { VideoPlayerRenderer } from './VideoPlayerRenderer.tsx'
import {
  VideoNotesRenderer,
  videoNotesLayoutContribution,
} from './VideoNotesRenderer.tsx'
import { videoPlayerMarkdownExtension } from './markdown.tsx'
import { videoNotesPaneRatioProp } from './view.ts'

export const videoPlayerPlugin: AppExtension = systemToggle({
  id: 'system:video-player',
  name: 'Video player',
  description: 'Inline playback for blocks whose content is a video URL.',
}).of([
  propertySchemasFacet.of(videoNotesPaneRatioProp, {source: 'video-player'}),
  blockRenderersFacet.of({id: 'videoPlayer', renderer: VideoPlayerRenderer}, {source: 'video-player'}),
  blockRenderersFacet.of({id: 'videoNotes', renderer: VideoNotesRenderer}, {source: 'video-player'}),
  blockLayoutFacet.of(videoNotesLayoutContribution, {source: 'video-player'}),
  markdownExtensionsFacet.of(videoPlayerMarkdownExtension, {source: 'video-player'}),
  shortcutSurfaceActivationsFacet.of(videoPlayerShortcutActivation, {source: 'video-player'}),
  videoPlayerActionsExtension,
])
