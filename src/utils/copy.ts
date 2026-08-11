import { Block } from '../data/block'
import { ClipboardData } from '../types'
import type { Repo } from '../data/repo'
import { selectionStateProp } from '@/data/properties.js'
import { setPendingMove } from '@/utils/pendingMove.js'

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

/** Exported so `cutBlockIdsToClipboard` (below) can write the SAME
 *  `ClipboardData` it also hands to `setPendingMove` — the register's
 *  `clipboardText` has to be exactly what landed on the OS clipboard, not a
 *  second, separately-serialized copy. */
export const writeToClipboard = async (data: ClipboardData): Promise<void> =>
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

  await copyBlockIdsToClipboard(selectionState.selectedBlockIds, repo)
}

/** Copy an explicit set of blocks, rather than re-deriving the set from the
 *  ui-state selection: an action dispatched with supplied deps (a group
 *  header button, the agent bridge) has no ui-state selection at all, so
 *  re-deriving would silently no-op there. */
export const copyBlockIdsToClipboard = async (
  blockIds: readonly string[],
  repo: Repo,
): Promise<void> => {
  if (!blockIds.length) {
    console.log('No blocks selected to copy')
    return
  }
  await writeToClipboard(await serializeSelectedBlocks([...blockIds], repo))
}

/** Cut: like `copyBlockIdsToClipboard`, but ALSO marks `blockIds` as a
 *  pending move (`@/utils/pendingMove.js`) instead of deleting them —
 *  nothing here touches the blocks table. A paste that later finds the
 *  register still valid (workspace matches, the OS clipboard is still
 *  exactly this markdown, every id still live, destination outside the
 *  moved subtrees — see `pasteAsMoveImpl` in the move-blocks plugin)
 *  completes the relocation via `moveBlocksTo`, preserving ids so refs into
 *  the cut subtree survive; anything else, including no paste at all,
 *  leaves the blocks exactly where they were.
 *
 *  Returns whether it actually marked anything — false for an empty
 *  `blockIds` or no active workspace, so callers (e.g. to decide whether to
 *  also clear a UI selection) don't have to re-check both. */
export const cutBlockIdsToClipboard = async (
  blockIds: readonly string[],
  repo: Repo,
): Promise<boolean> => {
  if (!blockIds.length) return false
  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId) return false

  const data = await serializeSelectedBlocks([...blockIds], repo)
  // Best-effort, and deliberately NOT awaited-then-thrown. The register is
  // what makes cut→paste a move; the clipboard write is the secondary
  // courtesy that lets the same cut paste into another app. Letting a
  // refused write (`NotAllowedError` — non-secure context, no user
  // gesture, a stricter browser) propagate would abort before
  // `setPendingMove` and make ⌘X a total no-op: nothing marked, nothing
  // deleted, no feedback. Verified reachable — the write is refused
  // outright in an automated browser context.
  let clipboardSynced = true
  try {
    await writeToClipboard(data)
  } catch (error) {
    clipboardSynced = false
    console.warn('[cut] clipboard write refused; marking the move anyway', error)
  }
  setPendingMove({blockIds, workspaceId, clipboardText: data.markdown, clipboardSynced})
  return true
}
