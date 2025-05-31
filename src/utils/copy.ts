import { Block } from '../data/block'
import { ClipboardData, BlockData } from '../types'
import { Repo } from '../data/repo'
import { selectionStateProp } from '@/data/properties.ts'

const createIndentedContent = (content: string, depth: number): string => {
  const indentBy = '  '
  const indentation = depth > 0 ? indentBy.repeat(depth) : ''
  return `${indentation}- ${content.split('\n').join('\n' + indentation + indentBy)}`
}

const processBlockRecursively = async (
  block: Block,
  depth: number,
): Promise<{ blocks: BlockData[]; markdown: string[] }> => {
  const blockData = await block.data()
  if (!blockData) {
    return {blocks: [], markdown: []}
  }

  const markdown = [createIndentedContent(blockData.content, depth)]
  const blocks = [blockData]

  const children = await block.children()
  const childResults = await Promise.all(
    children.map(child => processBlockRecursively(child, depth + 1)),
  )

  return {
    blocks: blocks.concat(...childResults.map(r => r.blocks)),
    markdown: markdown.concat(...childResults.map(r => r.markdown)),
  }
}

export const serializeBlock = async (block: Block): Promise<ClipboardData> => {
  const initialData = await block.data()
  if (!initialData) {
    throw new Error(`Failed to retrieve data for block with id ${block.id}`)
  }

  const {blocks, markdown} = await processBlockRecursively(block, 0)
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

const getSelectionState = async (uiStateBlock: Block) =>
  (await uiStateBlock.getProperty(selectionStateProp))?.value

export const serializeSelectedBlocks = async (
  blockIds: string[],
  repo: Repo,
): Promise<ClipboardData> => {
  const blockResults = await Promise.all(
    blockIds
      .map(id => repo.find(id))
      .filter((block): block is Block => block !== null)
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

  const selectionState = await getSelectionState(uiStateBlock)
  if (!selectionState?.selectedBlockIds?.length) {
    console.log('No blocks selected to copy')
    return
  }

  const clipboardData = await serializeSelectedBlocks(selectionState.selectedBlockIds, repo)
  await writeToClipboard(clipboardData)
}
