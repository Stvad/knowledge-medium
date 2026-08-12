import { Block } from '../data/block'
import { ClipboardData } from '../types'
import type { Repo } from '../data/repo'
import { selectionStateProp } from '@/data/properties.js'
import { clearPendingMove, setPendingMove } from '@/utils/pendingMove.js'
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

const createClipboardItem = (data: ClipboardData): ClipboardItem =>
  new ClipboardItem({
    'text/plain': new Blob([data.markdown], {type: 'text/plain'}),
    // Todo
    // 'application/json': new Blob([JSON.stringify(data.blocks)], {type: 'application/json'}),
  })

/** Exported so `cutBlockIdsToClipboard` (below) can write the SAME
 *  `ClipboardData` it also hands to `setPendingMove` — the register's
 *  `clipboardText` has to be exactly what landed on the OS clipboard, not a
 *  second, separately-serialized copy.
 *
 *  Clears any OTHER pending cut→move first: this write is about to put
 *  different content on the clipboard, which invalidates whatever move was
 *  pending (see `@/utils/pendingMove.js`) — without this, cutting block A,
 *  then copying block B, then pasting would silently MOVE A instead of
 *  copying B, because nothing ever told the register a different copy
 *  happened. Cleared unconditionally (before the write, not after) so it
 *  fires even when the write itself is refused. Harmless for the cut's OWN
 *  write: `cutBlockIdsToClipboard` calls this first and then calls
 *  `setPendingMove` right after, re-arming the register it just cleared. */
export const writeToClipboard = async (data: ClipboardData): Promise<void> => {
  clearPendingMove()
  await navigator.clipboard.write([createClipboardItem(data)])
}

export const copyBlockToClipboard = async (block: Block): Promise<void> =>
  writeToClipboard(await serializeBlock(block))

/** Plain-text counterpart to `writeToClipboard` above — same "clear any
 *  pending cut→move first" choke point, for the many call sites that write
 *  a bare string rather than the rich subtree `ClipboardItem` (a block id,
 *  a `((ref))`/`!((embed))`, a link, an audit sample, a resume command, an
 *  agent token, a workspace key, …). Every direct
 *  `navigator.clipboard.writeText` call site in the app should route
 *  through this (or `writeTextToClipboardBestEffort` below, for a caller
 *  that doesn't await/catch) instead of calling the browser API itself —
 *  see `writeToClipboard`'s doc for why bypassing the choke point is
 *  dangerous: a write that doesn't clear the register can leave it
 *  pointing at content the clipboard no longer holds, and the next paste
 *  silently MOVES whatever was cut instead of pasting what was just
 *  copied.
 *
 *  Delegates straight to `navigator.clipboard.writeText` — same
 *  synchronous-throw/rejection behaviour — so a caller that already
 *  awaits/catches a raw `navigator.clipboard.writeText(text)` call can
 *  swap this in unchanged. */
export const writeTextToClipboard = async (text: string): Promise<void> => {
  clearPendingMove()
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
  await writeToClipboard(await serializeSelectedBlocks([...blockIds], repo))
}

/** Cut: like `copyBlockIdsToClipboard`, but ALSO marks `blockIds` as a
 *  pending move (`@/utils/pendingMove.js`) instead of deleting them —
 *  nothing here touches the blocks table. A paste that later finds the
 *  register still valid (workspace matches, the clipboard sentinel still
 *  matches, at least one id still live, destination outside the moved
 *  subtrees — see `pasteAsMoveImpl` in the move-blocks plugin) completes
 *  the relocation via `moveBlocksTo`, preserving ids so refs into the cut
 *  subtree survive; anything else, including no paste at all, leaves the
 *  blocks exactly where they were.
 *
 *  Returns whether it actually marked anything — false for an empty
 *  `blockIds`, no active workspace, or a clipboard that's entirely
 *  unreachable (see below), so callers (e.g. to decide whether to also
 *  clear a UI selection) don't have to re-check.
 *
 *  Normalizes `blockIds` through `validateSelectionHierarchy` BEFORE
 *  serializing: an ancestor+descendant pair in the selection (the
 *  invariant is only enforced at write time — cache-only, nothing
 *  re-validates it after a sync-applied reparent lands under it) would
 *  otherwise serialize the descendant TWICE — once nested inside the
 *  ancestor's subtree, once again as its own top-level entry — duplicating
 *  it in the clipboard markdown. `moveBlocksTo` prunes the same way
 *  internally when the move eventually runs, so normalizing up front here
 *  keeps the register, the clipboard text, and the eventual move all
 *  describing the identical set.
 *
 *  Best-effort on the actual OS write, and deliberately NOT
 *  awaited-then-thrown: the register is what makes cut→paste a move; the
 *  clipboard write is the secondary courtesy that lets the same cut paste
 *  into another app. Letting a refused write (`NotAllowedError` —
 *  non-secure context, no user gesture, a stricter browser) propagate
 *  would abort before `setPendingMove` and make ⌘X a total no-op: nothing
 *  marked, nothing deleted, no feedback. Verified reachable — the write is
 *  refused outright in an automated browser context.
 *
 *  When the write is refused, the register still needs SOME invalidation
 *  sentinel (see `PendingMove.clipboardText`'s doc) — read back whatever is
 *  currently on the clipboard and use that: "nothing copied since the cut"
 *  is still a sound signal even though it isn't our own markdown. Only when
 *  BOTH the write and the read are refused is there no usable sentinel at
 *  all; the cut can't be marked, so it's abandoned outright (toast, no
 *  register) rather than armed with no invalidation check — that would let
 *  ANY next paste, anywhere, complete as a move. */
/** Monotonic id for in-flight cuts. A cut awaits (hierarchy validation,
 *  subtree serialization, the clipboard write), so two gestures can
 *  overlap and finish out of order — and the loser would otherwise publish
 *  its register on top of the winner's, leaving the clipboard showing one
 *  cut while the register points at another. Worse in the write-refused
 *  path below, where the late cut's read-back sentinel is the EARLIER
 *  cut's text: the sentinel then matches on the next paste and moves the
 *  wrong blocks. Each call takes a ticket and publishes only if it's still
 *  the newest. */
let cutGeneration = 0

export const cutBlockIdsToClipboard = async (
  blockIds: readonly string[],
  repo: Repo,
): Promise<boolean> => {
  if (!blockIds.length) return false
  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId) return false

  const generation = ++cutGeneration
  const superseded = (): boolean => generation !== cutGeneration

  const normalizedIds = await validateSelectionHierarchy([...blockIds], repo)

  const data = await serializeSelectedBlocks(normalizedIds, repo)
  // Defence in depth, NOT the load-bearing check — the one after the
  // write is (it's what stops a stale register from replacing the live
  // one, and what stops the read-back path arming these ids against a
  // newer cut's text). This earlier bail only keeps a superseded cut's
  // markdown off the clipboard; without it the post-write check still
  // holds the register correct and the worst outcome is a text paste of
  // the older cut's content. Unpinned by tests for that reason: the
  // suspension point it needs (`repo.query.subtree`, reached through a
  // dispatch Proxy) can't be stubbed without replacing `repo.query`
  // wholesale, which costs more than the case is worth.
  if (superseded()) return false

  let clipboardText = data.markdown
  try {
    await writeToClipboard(data)
  } catch (error) {
    console.warn('[cut] clipboard write refused; reading back the existing clipboard as the invalidation sentinel', error)
    try {
      clipboardText = await navigator.clipboard.readText()
    } catch (readError) {
      console.warn('[cut] clipboard read also refused; cut cannot be marked as a pending move', readError)
      showError("Couldn't access the clipboard — cut was cancelled")
      return false
    }
  }
  // Re-checked after the awaits above: the read-back sentinel in
  // particular could be a NEWER cut's text, which would arm these ids
  // against that cut's clipboard content.
  if (superseded()) return false
  // Arm with `data.serializedIds`, not `normalizedIds` — a root that
  // failed to serialize (see `SerializedSelection`'s doc) is absent from
  // `clipboardText` above yet would still relocate on paste if armed here,
  // moving content the clipboard never represented.
  setPendingMove({blockIds: data.serializedIds, workspaceId, clipboardText})
  return true
}
