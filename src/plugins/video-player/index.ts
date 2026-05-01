import { shortcutSurfaceActivationsFacet } from '@/extensions/blockInteraction.ts'
import { blockRenderersFacet } from '@/extensions/core.ts'
import { AppExtension } from '@/extensions/facet.ts'
import { markdownExtensionsFacet } from '@/markdown/extensions.ts'
import {
  videoPlayerActionsExtension,
  videoPlayerShortcutActivation,
} from './actions.ts'
import { VideoPlayerRenderer } from './VideoPlayerRenderer.tsx'
import { videoPlayerMarkdownExtension } from './markdown.tsx'

export const videoPlayerPlugin: AppExtension = [
  blockRenderersFacet.of({id: 'videoPlayer', renderer: VideoPlayerRenderer}, {source: 'video-player'}),
  markdownExtensionsFacet.of(videoPlayerMarkdownExtension, {source: 'video-player'}),
  shortcutSurfaceActivationsFacet.of(videoPlayerShortcutActivation, {source: 'video-player'}),
  videoPlayerActionsExtension,
]
