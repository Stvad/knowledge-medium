import { Block } from '@/data/internals/block'
import { ClipboardData, BlockData } from '../types'
import type { Repo } from '@/data/internals/repo'
import { selectionStateProp } from '@/data/properties.ts'

const createIndentedContent = (content: string, depth: number): string => {
  const indentBy = '  '
  const indentation = depth > 0 ? indentBy.repeat(depth) : ''
  return `${indentation}- ${content.split('\n').join('\n' + indentation + indentBy)}`
}

/** Walk the subtree rooted at `block` and produce an indented
 *  markdown serialization + the BlockData[] in document order. The
 *  walk reads from cache exclusively (callers must `repo.load(id,
 *  {descendants: true})` first); each level descends via
 *  `block.children` (sync, gated on `areChildrenLoaded`). */
const processBlockRecursively = (
  block: Block,
  depth: number,
): { blocks: BlockData[]; markdown: string[] } => {
  const data = block.peek()
  if (!data) return {blocks: [], markdown: []}

  const markdown = [createIndentedContent(data.content, depth)]
  const blocks: BlockData[] = [data]

  // children getter throws if children not loaded; we caught loading
  // upstream in serializeBlock.
  for (const child of block.children) {
    const sub = processBlockRecursively(child, depth + 1)
    blocks.push(...sub.blocks)
    markdown.push(...sub.markdown)
  }

  return {blocks, markdown}
}

export const serializeBlock = async (block: Block): Promise<ClipboardData> => {
  // Hydrate the entire subtree before the sync walk.
  const data = await block.repo.load(block.id, {descendants: true})
  if (!data) {
    throw new Error(`Failed to retrieve data for block with id ${block.id}`)
  }

  const {blocks, markdown} = processBlockRecursively(block, 0)
  if (blocks.length === 0) {
    throw new Error(`No block data could be serialized for block with id ${block.id}`)
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
