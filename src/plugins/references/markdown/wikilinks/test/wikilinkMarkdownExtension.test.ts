import { describe, it, expect } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import { visit } from 'unist-util-visit'
import type { Root } from 'mdast'
import type { PluggableList } from 'unified'
import type { BlockData } from '@/data/api'
import type { Block } from '@/data/block'
import type { BlockContextType } from '@/types.js'
import { wikilinkMarkdownExtension } from '../index.tsx'

/** A Block facade whose cached snapshot (`peek()`) is deliberately STALE —
 *  it carries no references. The reactive render data passed in the context
 *  is the up-to-date view. */
const staleBlock = (peekReferences: BlockData['references']): Block =>
  ({
    id: 'source-block',
    peek: () => ({
      id: 'source-block',
      workspaceId: 'ws-1',
      content: '[[Target]]',
      references: peekReferences,
      properties: {},
    } as BlockData),
  } as unknown as Block)

const resolvedBlockId = (md: string, remarkPlugins: PluggableList): string => {
  const processor = unified().use(remarkParse).use(remarkPlugins)
  const tree = processor.runSync(processor.parse(md)) as Root
  let blockId = '__no-wikilink-node__'
  visit(tree, (node) => {
    if ((node as { type: string }).type === 'wikilink') {
      blockId = (node as unknown as { data: { hProperties: { blockId: string } } }).data.hProperties.blockId
    }
  })
  return blockId
}

describe('wikilinkMarkdownExtension', () => {
  it('resolves links from the reactive render data, not block.peek()', () => {
    // Regression guard for the React-Compiler reactivity bug: the async
    // references parse has landed in the render data the subscribed renderer
    // sees, but NOT in `block.peek()`'s snapshot. The resolver must derive its
    // alias→id map from the reactive `data`, otherwise the memoized resolver
    // (keyed on the identity-stable `block`) captures an empty peek() once and
    // the `[[alias]]` stays unresolved until a remount.
    const config = wikilinkMarkdownExtension({
      block: staleBlock([]),
      blockContext: {} as BlockContextType,
      data: {
        content: '[[Target]]',
        references: [{ id: 'target-id', alias: 'Target' }],
        workspaceId: 'ws-1',
      },
    })
    if (!config) throw new Error('expected a markdown config')
    expect(resolvedBlockId('[[Target]]', config.remarkPlugins ?? [])).toBe('target-id')
  })

  it('does not resolve a block-ref entry (alias === id) as a page wikilink', () => {
    // Block refs store alias === id; the refMap filters them out so a stray
    // `[[uuid]]` can't silently resolve via a block-ref reference. The node is
    // still emitted, but with an empty blockId (a miss), not the uuid.
    const config = wikilinkMarkdownExtension({
      block: staleBlock([]),
      blockContext: {} as BlockContextType,
      data: {
        content: '[[abc-id]]',
        references: [{ id: 'abc-id', alias: 'abc-id' }],
        workspaceId: 'ws-1',
      },
    })
    if (!config) throw new Error('expected a markdown config')
    expect(resolvedBlockId('[[abc-id]]', config.remarkPlugins ?? [])).toBe('')
  })
})
