import type { ParsedBlock } from '@/utils/markdownParser'

/** A parsed forest as nested content: what a paste builds, read back. */
export interface RebuiltNode {
  content: string
  children: RebuiltNode[]
}

/** The blocks whose `parentId` is `parentId`, in `orderKey` order. The
 *  pointers are the source of truth: a `ParsedBlock` carries no child list. */
export const childrenOf = (blocks: readonly ParsedBlock[], parentId: string | undefined): ParsedBlock[] =>
  blocks
    .filter(block => block.parentId === parentId)
    .sort((a, b) => (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0))

/** The forest rebuilt from `parentId` + `orderKey`, roots first. */
export const outlineOf = (blocks: readonly ParsedBlock[], parentId?: string): RebuiltNode[] =>
  childrenOf(blocks, parentId).map(block => ({content: block.content, children: outlineOf(blocks, block.id)}))
