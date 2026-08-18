import {
  blockLayoutFacet,
  blockRendererFacet,
  shortcutSurfaceActivationsFacet,
} from '@/extensions/blockInteraction.js'
import { definitionSeedsFacet } from '@/data/facets.js'
import { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { markdownExtensionsFacet } from '@/markdown/extensions.js'
import {
  videoPlayerActionsExtension,
  videoPlayerShortcutActivation,
} from './actions.ts'
import { videoPlayerRendererRegistration } from './VideoPlayerRenderer.tsx'
import {
  videoNotesLayoutRegistration,
  videoNotesRendererRegistration,
} from './VideoNotesRenderer.tsx'
import { videoPlayerMarkdownExtension } from './markdown.tsx'
import { videoNotesPaneRatioProp } from './view.ts'

export const videoPlayerPlugin: AppExtension = systemToggle({
  id: 'system:video-player',
  name: 'Video player',
  description: 'Inline playback for blocks whose content is a video URL.',
}).of([
  definitionSeedsFacet.of(videoNotesPaneRatioProp, {source: 'video-player'}),
  blockRendererFacet.of(videoPlayerRendererRegistration, {source: 'video-player', precedence: 5}),
  // Above the plain player: in video-notes mode the notes arrangement wins.
  blockRendererFacet.of(videoNotesRendererRegistration, {source: 'video-player', precedence: 10}),
  blockLayoutFacet.of(videoNotesLayoutRegistration, {source: 'video-player'}),
  markdownExtensionsFacet.of(videoPlayerMarkdownExtension, {source: 'video-player'}),
  shortcutSurfaceActivationsFacet.of(videoPlayerShortcutActivation, {source: 'video-player'}),
  videoPlayerActionsExtension,
])
