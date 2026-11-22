// @vitest-environment node

import { describe, expect, it } from 'vitest'
import type { Block } from '@/data/block'
import type { BlockData } from '@/data/api'
import type { BlockShortcutDependencies, CodeMirrorEditModeDependencies } from '@/shortcuts/types.js'
import { insertImageAction, insertImageNormalModeAction } from './insertImageContribution.ts'

const blockWith = (properties: Record<string, unknown>): Block =>
  ({id: 'b', peek: () => ({id: 'b', content: '<p>x</p>', properties}) as unknown as BlockData}) as unknown as Block

describe('Insert image in the palette', () => {
  it.each([
    ['at the caret', (block: Block) => insertImageAction.isVisible?.({block} as CodeMirrorEditModeDependencies)],
    ['by appending', (block: Block) => insertImageNormalModeAction.isVisible?.({block} as BlockShortcutDependencies)],
  ])('is offered %s on an ordinary block and not on source', (_name, visible) => {
    expect(visible(blockWith({}))).toBe(true)
    expect(visible(blockWith({types: ['html-document']}))).toBe(false)
  })
})
