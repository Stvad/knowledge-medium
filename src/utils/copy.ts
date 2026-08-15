import { Block } from '../data/block'
import { ClipboardData } from '../types'
import type { Repo } from '../data/repo'
import { selectionStateProp } from '@/data/properties.js'
import { encodePayloadHtml, rememberPayload, type ClipboardPayload } from '@/paste/clipboardPayload.js'
import { showError } from '@/utils/toast.js'
import { validateSelectionHierarchy } from '@/utils/selection.js'

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

/** Both flavors, always in step because they're built from the same
 *  `markdown` in one place. The html flavor is what carries block identity
 *  to a paste (`@/paste/clipboardPayload.js`); the plain-text flavor stays
 *  the canonical rendering and is what other apps mostly take. */
const createClipboardItem = (data: ClipboardData, payload: ClipboardPayload): ClipboardItem =>
  new ClipboardItem({
    'text/plain': new Blob([data.markdown], {type: 'text/plain'}),
    'text/html': new Blob([encodePayloadHtml(data.markdown, payload)], {type: 'text/html'}),
  })

/** Write `data` to the OS clipboard, tagged with the identity of the
 *  blocks it came from.
 *
 *  `rememberPayload` covers the paste paths that can only read
 *  `text/plain` (a bare `p` keypress fires no paste event, so there are no
 *  flavors to read); the html flavor covers everything else and works
 *  across tabs. Both are keyed by the content itself, so there is nothing
 *  to invalidate here when a later copy happens — see
 *  `@/paste/clipboardPayload.js`.
 *
 *  Remembered BEFORE the await: if the write is refused, the OS clipboard
 *  keeps whatever it had, and the table entry for text we never wrote is
 *  simply unreachable. */
export const writeToClipboard = async (
  data: ClipboardData,
  payload: ClipboardPayload,
): Promise<void> => {
  rememberPayload(data.markdown, payload)
  await navigator.clipboard.write([createClipboardItem(data, payload)])
}

export const copyBlockToClipboard = async (block: Block): Promise<void> => {
  const data = await serializeBlock(block)
  const workspaceId = block.peek()?.workspaceId ?? block.repo.activeWorkspaceId
  if (!workspaceId) return
  await writeToClipboard(data, {blockIds: [block.id], workspaceId, intent: 'copy'})
}

/** Plain-text counterpart to `writeToClipboard`, for the call sites that
 *  write a bare string rather than a block subtree (a block id, a
 *  `((ref))`/`!((embed))`, a link, an audit sample, a resume command, an
 *  agent token, a workspace key, …). These carry no block identity, so
 *  they write no payload.
 *
 *  A named seam rather than load-bearing machinery: it used to be the
 *  choke point where every clipboard write cleared the pending-move
 *  register, and skipping it could make the next paste move the wrong
 *  blocks. Nothing depends on it now — clipboard payloads are keyed by
 *  content, so a write that bypassed this would be resolved correctly
 *  anyway. Kept because one place for clipboard text writes is worth
 *  having, not because correctness needs it. */
export const writeTextToClipboard = async (text: string): Promise<void> => {
  await navigator.clipboard.writeText(text)
}

/** Fire-and-forget wrapper around `writeTextToClipboard`, for handlers
 *  that don't await/catch it — the block-level "copy *" actions
 *  (ref/embed/content/link in `@/shortcuts/blockActions.js`, id/ref/embed
 *  in the bullet context menu). Swallows the write's own failure
 *  (including a missing `navigator.clipboard` entirely — non-secure
 *  context, or a test environment that never mocked it) so it doesn't
 *  surface as an unhandled-rejection warning; these copies are
 *  informational; unlike cut, nothing depends on the OS write actually
 *  landing (`cutBlockIdsToClipboard` handles ITS write failure
 *  explicitly). The pending-move clear itself is unconditional and
 *  synchronous either way. */
export const writeTextToClipboardBestEffort = (text: string): void => {
  void writeTextToClipboard(text).catch(() => {})
}

const getSelectionState = (uiStateBlock: Block) =>
  uiStateBlock.peekProperty(selectionStateProp)

export interface SerializedSelection extends ClipboardData {
  /** The subset of `blockIds`, in the same order, that ACTUALLY
   *  serialized. A root that failed (deleted since selection, unreadable
   *  subtree, …) is silently absent from `markdown`/`blocks` above — a
   *  caller that arms something keyed by block id (a pending cut→move
   *  register: `cutBlockIdsToClipboard`) MUST use this, not the original
   *  `blockIds`. Arming a failed root too would let it be acted on later
   *  (e.g. moved on paste) as though the clipboard represented it, when it
   *  never did. */
  serializedIds: string[]
}

export const serializeSelectedBlocks = async (
  blockIds: string[],
  repo: Repo,
): Promise<SerializedSelection> => {
  const blockResults = await Promise.all(
    blockIds.map(async id => {
      try {
        return {id, data: await serializeBlock(repo.block(id))}
      } catch (error) {
        console.error(`Failed to serialize block ${id}:`, error)
        return null
      }
    }),
  )

  const validResults = blockResults.filter(
    (result): result is {id: string; data: ClipboardData} => result !== null,
  )

  if (validResults.length === 0) {
    throw new Error('No block data could be serialized for copying')
  }

  return {
    markdown: validResults.map(r => r.data.markdown).join('\n'),
    blocks: validResults.flatMap(r => r.data.blocks),
    serializedIds: validResults.map(r => r.id),
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
  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId) return
  const data = await serializeSelectedBlocks([...blockIds], repo)
  await writeToClipboard(data, {
    blockIds: data.serializedIds,
    workspaceId,
    intent: 'copy',
  })
}

/** Cut: `copyBlockIdsToClipboard` with `intent: 'cut'`, so a paste that
 *  recognises the payload RELOCATES these blocks (ids preserved, refs into
 *  the subtree survive) instead of re-parsing the markdown into new ones.
 *  Nothing here touches the blocks table — no paste, no change.
 *
 *  Returns whether the cut is live, so callers can decide whether to also
 *  clear a UI selection.
 *
 *  Normalizes through `validateSelectionHierarchy` BEFORE serializing: an
 *  ancestor+descendant pair in the selection (the invariant is enforced
 *  only at write time — cache-only, nothing re-validates it after a
 *  sync-applied reparent lands under it) would otherwise serialize the
 *  descendant TWICE, once nested in the ancestor's subtree and once as its
 *  own entry. `moveBlocksTo` prunes identically when the move runs, so
 *  normalizing here keeps the payload, the clipboard text and the eventual
 *  move describing the same set.
 *
 *  Carries `data.serializedIds`, not `normalizedIds`: a root that failed
 *  to serialize (see `SerializedSelection`) is absent from the markdown
 *  and must be absent from the payload too, or a paste would relocate
 *  content the clipboard never represented.
 *
 *  A refused OS write (`NotAllowedError` — non-secure context, no user
 *  gesture) fails the cut outright rather than half-arming it. Nothing to
 *  unwind: the payload is remembered against text that never reached the
 *  clipboard, so no paste can match it. (The old register needed an
 *  elaborate read-back-the-clipboard-as-a-sentinel dance here precisely
 *  because it COULD be armed independently of the write.) */
export const cutBlockIdsToClipboard = async (
  blockIds: readonly string[],
  repo: Repo,
): Promise<boolean> => {
  if (!blockIds.length) return false
  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId) return false

  const normalizedIds = await validateSelectionHierarchy([...blockIds], repo)
  const data = await serializeSelectedBlocks(normalizedIds, repo)

  try {
    await writeToClipboard(data, {
      blockIds: data.serializedIds,
      workspaceId,
      intent: 'cut',
    })
  } catch (error) {
    console.warn('[cut] clipboard write refused; cut cancelled', error)
    showError("Couldn't access the clipboard — cut was cancelled")
    return false
  }
  return true
}
