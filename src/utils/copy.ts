import { Block } from '../data/block'
import { ClipboardData } from '../types'
import type { Repo } from '../data/repo'
import { selectionStateProp } from '@/data/properties.js'
import { armCut, disarmCut } from '@/paste/armedCut.js'

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
  // eslint-disable-next-line no-restricted-syntax -- this module is the clipboard writer
  navigator.clipboard.write([createClipboardItem(data)])

/** Copy: the clipboard no longer holds a cut, so a paste must not move one.
 *  Disarmed only once the write RESOLVED; a refused write leaves the cut on
 *  the clipboard. */
const copyToClipboard = async (data: ClipboardData): Promise<void> => {
  await writeToClipboard(data)
  disarmCut()
}

/** Write `text` to the clipboard: the app's one plain-text clipboard writer,
 *  enforced by lint. Whatever it writes replaces a cut on the clipboard, so it
 *  disarms that cut once the write resolved (see {@link copyToClipboard}). */
export const writeTextToClipboard = async (text: string): Promise<void> => {
  // eslint-disable-next-line no-restricted-syntax -- this module is the clipboard writer
  await navigator.clipboard.writeText(text)
  disarmCut()
}

export const copyBlockToClipboard = async (block: Block): Promise<void> =>
  copyToClipboard(await serializeBlock(block))

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

/** Copy an explicit set of blocks. `cut` needs this: it deletes the blocks its
 *  DEPS name, and re-deriving the copy set from the ui-state selection means
 *  the two can disagree — an action dispatched with supplied deps (a group
 *  header button, the agent bridge) has no ui-state selection at all, so the
 *  copy silently no-ops while the delete still runs. Cut what you delete. */
export const copyBlockIdsToClipboard = async (
  blockIds: readonly string[],
  repo: Repo,
): Promise<void> => {
  if (!blockIds.length) {
    console.log('No blocks selected to copy')
    return
  }
  await copyToClipboard(await serializeSelectedBlocks([...blockIds], repo))
}

/** Cut `blockIds` (roots, in document order): put them on the clipboard and
 *  arm them to MOVE on the next paste in the app (`@/paste/armedCut.js`).
 *  Deletes nothing: the blocks stay where they are until that paste.
 *
 *  Armed only after the write resolved. A refused write throws, and the
 *  clipboard still holds whatever it held before, which the cut must not
 *  claim.
 *
 *  `'empty'`: the blocks serialize to no text (one blank, childless block),
 *  and a paste of no text never reaches the paste handlers, so nothing could
 *  complete the cut. Nothing is written or armed. */
export const cutBlockIdsToClipboard = async (
  blockIds: readonly string[],
  repo: Repo,
): Promise<'cut' | 'empty'> => {
  if (!blockIds.length) return 'empty'
  const first = repo.block(blockIds[0])
  const workspaceId = (first.peek() ?? await first.load())?.workspaceId
  if (!workspaceId) throw new Error(`Cannot cut: block ${blockIds[0]} not found`)
  const data = await serializeSelectedBlocks([...blockIds], repo)
  if (data.markdown === '') return 'empty'
  await writeToClipboard(data)
  await armCut(data.markdown, {workspaceId, rootIds: blockIds})
  return 'cut'
}
