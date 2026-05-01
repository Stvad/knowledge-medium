import { Block } from '@/data/internals/block'
import { ClipboardData } from '../types'
import type { Repo } from '@/data/internals/repo'
import { selectionStateProp } from '@/data/properties.ts'

const createIndentedContent = (content: string, depth: number): string => {
  const indentBy = '  '
  const indentation = depth > 0 ? indentBy.repeat(depth) : ''
  return `${indentation}- ${content.split('\n').join('\n' + indentation + indentBy)}`
}

export const serializeBlock = async (block: Block): Promise<ClipboardData> => {
  // One SQL query hydrates the entire subtree in document order
  // (SUBTREE_SQL ORDER BY path). We compute depth by walking that
  // flat list once — the root sits at depth 0; every other row's
  // depth is `parentDepth + 1` (parent must already have appeared
  // since the query is depth-first). No per-parent handle creation,
  // no recursive cache reads.
  const blocks = await block.repo.loadSubtree(block.id, {includeRoot: true})
  if (blocks.length === 0) {
    throw new Error(`No block data could be serialized for block with id ${block.id}`)
  }

  const depthById = new Map<string, number>()
  const markdown: string[] = []
  for (const b of blocks) {
    const depth = b.id === block.id
      ? 0
      : (depthById.get(b.parentId ?? '') ?? 0) + 1
    depthById.set(b.id, depth)
    markdown.push(createIndentedContent(b.content, depth))
  }

  return {
    markdown: markdown.join('\n'),
    blocks,
  }
}

const createClipboardItem = (data: ClipboardData): ClipboardItem =>
  new ClipboardItem({
    'text/plain': new Blob([data.markdown], {type: 'text/plain'}),
    // Todo
    // 'application/json': new Blob([JSON.stringify(data.blocks)], {type: 'application/json'}),
  })

const writeToClipboard = async (data: ClipboardData): Promise<void> =>
  navigator.clipboard.write([createClipboardItem(data)])

export const copyBlockToClipboard = async (block: Block): Promise<void> =>
  writeToClipboard(await serializeBlock(block))

const getSelectionState = (uiStateBlock: Block) =>
  uiStateBlock.peekProperty(selectionStateProp)

export const serializeSelectedBlocks = async (
  blockIds: string[],
  repo: Repo,
): Promise<ClipboardData> => {
  const blockResults = await Promise.all(
    blockIds
      .map(id => repo.block(id))
      .map(async block => {
        try {
          return await serializeBlock(block)
        } catch (error) {
          console.error(`Failed to serialize block ${block.id}:`, error)
          return null
        }
      }),
  )

  const validResults = blockResults.filter((result): result is ClipboardData => result !== null)

  if (validResults.length === 0) {
    throw new Error('No block data could be serialized for copying')
  }

  return {
    markdown: validResults.map(r => r.markdown).join('\n'),
    blocks: validResults.flatMap(r => r.blocks),
  }
}

export const copySelectedBlocksToClipboard = async (
  uiStateBlock: Block,
  repo: Repo,
): Promise<void> => {
  if (!uiStateBlock || !repo) return

  const selectionState = getSelectionState(uiStateBlock)
  if (!selectionState?.selectedBlockIds?.length) {
    console.log('No blocks selected to copy')
    return
  }

  const clipboardData = await serializeSelectedBlocks(selectionState.selectedBlockIds, repo)
  await writeToClipboard(clipboardData)
}
