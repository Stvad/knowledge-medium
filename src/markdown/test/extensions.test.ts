import { describe, expect, it } from 'vitest'
import type { Block } from '@/data/block.ts'
import {
  isMarkdownExtension,
  resolveMarkdownRenderConfig,
} from '@/markdown/extensions.ts'
import type { Components } from 'react-markdown'
import type { Plugin } from 'unified'

const block = {} as Block
const basePlugin: Plugin = () => undefined
const videoPlugin: Plugin = () => undefined

describe('markdown extensions', () => {
  it('resolves plugins and components from matching extensions', () => {
    const baseComponents: Components = {p: 'p'}
    const videoComponents: Components = {strong: 'strong'}

    const config = resolveMarkdownRenderConfig([
      {
        id: 'base',
        remarkPlugins: [basePlugin],
        components: baseComponents,
      },
      {
        id: 'video',
        appliesTo: ({blockContext}) => blockContext.videoPlayerBlockId === 'video-1',
        remarkPlugins: () => [videoPlugin],
        components: () => videoComponents,
      },
    ], {
      block,
      blockContext: {videoPlayerBlockId: 'video-1'},
    })

    expect(config.remarkPlugins).toEqual([basePlugin, videoPlugin])
    expect(config.components).toEqual({
      p: 'p',
      strong: 'strong',
    })
  })

  it('skips extensions that do not apply to the current markdown context', () => {
    const config = resolveMarkdownRenderConfig([
      {
        id: 'base',
        remarkPlugins: [basePlugin],
      },
      {
        id: 'video',
        appliesTo: ({blockContext}) => blockContext.videoPlayerBlockId === 'video-1',
        remarkPlugins: [videoPlugin],
      },
    ], {
      block,
      blockContext: {},
    })

    expect(config.remarkPlugins).toEqual([basePlugin])
  })

  it('validates the public markdown extension shape', () => {
    expect(isMarkdownExtension({
      id: 'valid',
      remarkPlugins: [],
      components: {},
    })).toBe(true)

    expect(isMarkdownExtension({
      id: 'invalid',
      remarkPlugins: {},
    })).toBe(false)
  })
})
