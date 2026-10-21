import { describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { definitionSeedsFacet } from '@/data/facets.js'
import type { Block } from '@/data/block'
import { makeBlockData } from '@/data/test/factories.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import type { Repo } from '@/data/repo'
import type { BlockRendererContext } from '@/extensions/blockInteraction.js'
import { videoPlayerPlugin } from '../index.ts'
import { videoNotesPaneRatioProp } from '../view.ts'
import { VideoPlayerRenderer, videoPlayerRendererRegistration } from '../VideoPlayerRenderer.tsx'
import { VideoNotesRenderer } from '../VideoNotesRenderer.tsx'
import { blockRendererFacet } from '@/extensions/blockInteraction.js'
import { VIDEO_NOTES_VIEW_MODE } from '../view.ts'

const blockWithContent = (content: string): Block => ({
  id: 'video',
  peek: () => makeBlockData({
    id: 'video',
    workspaceId: 'ws-1',
    content,
  }),
} as unknown as Block)

// The player OFFERS itself for anything (an explicit `renderer: videoPlayer`
// has to keep working on a block it wouldn't take by itself) — what varies is
// whether it CLAIMS the block.
const canRenderContent = (content: string) => {
  const ctx: BlockRendererContext = {block: blockWithContent(content), repo: {} as Repo, types: []}
  const facts = videoPlayerRendererRegistration.resolve?.(ctx)
  return facts ? facts.claims === true : false
}

describe('videoPlayerPlugin', () => {
  it('contributes its player property seeds', () => {
    const runtime = resolveFacetRuntimeSync(videoPlayerPlugin)
    const seeds = runtime.read(definitionSeedsFacet)

    expect(seeds).toEqual(expect.arrayContaining([videoNotesPaneRatioProp]))
    // video:playerView is retired — the pane mode (panelViewModeProp) owns
    // the notes view now; stale per-block values are ignored dead data.
    expect(seeds.some(seed => seed.name === 'video:playerView')).toBe(false)
    expect(videoNotesPaneRatioProp.changeScope).toBe(ChangeScope.UserPrefs)
  })

  it('renders standalone playable URLs after trimming whitespace', () => {
    expect(canRenderContent('\n  https://example.com/video.mp4 \t')).toBe(true)
  })

  it('does not render blocks that contain other content around a playable URL', () => {
    expect(canRenderContent('Watch this: https://example.com/video.mp4')).toBe(false)
    expect(canRenderContent('https://example.com/video.mp4\nnotes')).toBe(false)
  })

  it('does not render playable relative paths as video URLs', () => {
    expect(canRenderContent('video.mp4')).toBe(false)
  })

  // Both renderers claim a playable block in the mode; the winner is decided
  // by the precedences the plugin registers them at, which nothing else in
  // either file states.
  it('gives the notes arrangement the block in video-notes mode, over the plain player', () => {
    const resolve = resolveFacetRuntimeSync(videoPlayerPlugin).read(blockRendererFacet)
    const block = blockWithContent('https://example.com/video.mp4')
    const inMode = {
      block,
      repo: {} as Repo,
      types: [],
      blockContext: {panelViewMode: VIDEO_NOTES_VIEW_MODE, scopeRootId: block.id},
    }

    expect(resolve(inMode).all.map(variant => variant.render))
      .toEqual(expect.arrayContaining([VideoPlayerRenderer, VideoNotesRenderer]))
    expect(resolve(inMode).last?.render).toBe(VideoNotesRenderer)
    expect(resolve({...inMode, blockContext: {}}).last?.render).toBe(VideoPlayerRenderer)
  })
})
