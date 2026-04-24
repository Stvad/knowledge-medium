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
  it('resolves plugins and components from extension functions', () => {
    const baseComponents: Components = {p: 'p'}
    const videoComponents: Components = {strong: 'strong'}

    const config = resolveMarkdownRenderConfig([
      () => ({
        remarkPlugins: [basePlugin],
        components: baseComponents,
      }),
      () => ({
        remarkPlugins: [videoPlugin],
        components: videoComponents,
      }),
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
      () => ({
        remarkPlugins: [basePlugin],
      }),
      ({blockContext}) => blockContext.videoPlayerBlockId === 'video-1'
        ? {remarkPlugins: [videoPlugin]}
        : null,
    ], {
      block,
      blockContext: {},
    })

    expect(config.remarkPlugins).toEqual([basePlugin])
  })

  it('validates the public markdown extension shape', () => {
    expect(isMarkdownExtension(() => null)).toBe(true)
    expect(isMarkdownExtension({remarkPlugins: []})).toBe(false)
  })
})
