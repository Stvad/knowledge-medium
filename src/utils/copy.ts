import { Block } from '../data/block'
import { ClipboardData } from '../types'
import type { Repo } from '../data/repo'
import { selectionStateProp } from '@/data/properties.js'

const createIndentedContent = (content: string, depth: number): string => {
  const indentBy = '  '
  const indentation = depth > 0 ? indentBy.repeat(depth) : ''
  return `${indentation}- ${content.split('\n').join('\n' + indentation + indentBy)}`
}

export const serializeBlock = async (block: Block): Promise<ClipboardData> => {
  // One SQL query hydrates the entire subtree in document order
  // (SUBTREE_SQL ORDER BY path), each row carrying its `depth` relative to
  // the root (0 for the root). No per-parent handle creation, no recursive
  // cache reads, and no re-deriving depth here.
  //
  // `hidePropertyChildren` prunes EVERY recognized field row today, which is
  // correct only while all workspaces read 'cell' (nothing is child-backed,
  // so nothing is pruned). Copy is WYSIWYG per §10 — default copy serializes
  // exactly the visible view, so once slice D's tier-aware predicate lands a
  // NON-hidden property row travels with its subtree and only hidden-tier
  // subtrees prune whole. That switch also closes #404's copy gap by
  // construction: user content nested under a visible property's value stops
  // being dropped along with the machinery. Content under a HIDDEN property's
  // value still won't travel on default copy — an accepted WYSIWYG
  // consequence, covered by the explicit "copy with hidden properties"
  // command rather than by widening this call.
  const blocks = await block.repo.query.subtree({id: block.id, hidePropertyChildren: true}).load()
  if (blocks.length === 0) {
    throw new Error(`No block data could be serialized for block with id ${block.id}`)
  }

  if (blocks.length === 1) {
    return {
      markdown: blocks[0].content,
      blocks,
    }
  }

  return {
    markdown: blocks.map(b => createIndentedContent(b.content, b.depth)).join('\n'),
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
