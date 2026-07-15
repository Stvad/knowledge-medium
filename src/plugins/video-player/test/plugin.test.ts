import { describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { definitionSeedsFacet } from '@/data/facets.js'
import type { Block } from '@/data/block'
import { makeBlockData } from '@/data/test/factories.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { videoPlayerPlugin } from '../index.ts'
import { videoNotesPaneRatioProp } from '../view.ts'
import { VideoPlayerRenderer } from '../VideoPlayerRenderer.tsx'

const blockWithContent = (content: string): Block => ({
  id: 'video',
  peek: () => makeBlockData({
    id: 'video',
    workspaceId: 'ws-1',
    content,
  }),
} as unknown as Block)

const canRenderContent = (content: string) =>
  VideoPlayerRenderer.canRender?.({block: blockWithContent(content)}) ?? false

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
})
