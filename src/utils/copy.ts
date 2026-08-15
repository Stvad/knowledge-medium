import { v4 as uuidv4 } from 'uuid'
import { Block } from '../data/block'
import { ClipboardData } from '../types'
import type { Repo } from '../data/repo'
import { selectionStateProp } from '@/data/properties.js'
import {
  encodePayloadHtml,
  forgetPayload,
  rememberPayload,
  type ClipboardPayload,
} from '@/paste/clipboardPayload.js'
import { showError } from '@/utils/toast.js'

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
 *  Remembered only AFTER the write resolves. Doing it first looked safe —
 *  "the entry is for text that never reached the clipboard, so nothing can
 *  match it" — but that reasoning is wrong whenever the clipboard ALREADY
 *  holds this same markdown (the user copied these blocks a moment ago).
 *  Then a refused write leaves the text in place, the entry matches it,
 *  and a paste moves blocks for a cut that reported itself cancelled. */
export const writeToClipboard = async (
  data: ClipboardData,
  payload: ClipboardPayload,
): Promise<void> => {
  await navigator.clipboard.write([createClipboardItem(data, payload)])
  rememberPayload(data.markdown, payload)
}

export const copyBlockToClipboard = async (block: Block): Promise<void> => {
  const data = await serializeBlock(block)
  const workspaceId = block.peek()?.workspaceId ?? block.repo.activeWorkspaceId
  if (!workspaceId) return
  await writeToClipboard(data, {blockIds: [block.id], workspaceId, intent: 'copy', cutId: uuidv4()})
}

/** Plain-text counterpart to `writeToClipboard`, for the call sites that
 *  write a bare string rather than a block subtree (a block id, a
 *  `((ref))`/`!((embed))`, a link, an audit sample, a resume command, an
 *  agent token, a workspace key, …). These carry no block identity, so
 *  they write no payload.
 *
 *  Drops any remembered payload for the text it writes. This is NOT the
 *  old register's "invalidate on every write" — it's the same rule every
 *  other write here follows: record what the clipboard now holds for this
 *  content. A bare string carries no block identity, so what it records is
 *  "this text is not a cut". Without it, cutting a block whose text is `T`
 *  and then copying the identical text `T` from another block (`y c`, and
 *  duplicate one-liners are ordinary in an outline) would leave the cut
 *  entry standing, and the next paste would move the cut block instead of
 *  inserting what was just copied.
 *
 *  Note the limit this does NOT reach: text copied from ANOTHER APP never
 *  passes through here, so identical text from outside still resolves to a
 *  remembered cut on the text-only paste paths. That is inherent to
 *  fingerprinting a text-only clipboard by its content, and it is not new
 *  — the pending-move register's sentinel compared the same way. Pastes
 *  that carry `text/html` are unaffected: the digest check in
 *  `resolveClipboardPayload` rejects a payload whose text doesn't match. */
export const writeTextToClipboard = async (text: string): Promise<void> => {
  await navigator.clipboard.writeText(text)
  forgetPayload(text)
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
 *  explicitly).
 *
 *  Note the payload bookkeeping is skipped along with the write: a refused
 *  write never reaches `forgetPayload`, so any entry for this text stays.
 *  Harmless — the clipboard still holds whatever it held, which is what
 *  that entry describes. */
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

  // Drop any root that turned out to live inside ANOTHER root's subtree,
  // judged by the rows we just fetched rather than by a separate earlier
  // read. Callers do pre-validate the selection's hierarchy, but that
  // check and these subtree reads are different snapshots: a sync-applied
  // reparent landing between them makes B a child of A after B was
  // accepted as its own root, and the markdown then contains B twice —
  // once nested in A, once standalone. `moveBlocksTo` re-prunes and so
  // moves it once, but the paths that DON'T move (a cross-workspace
  // paste, or the plugin being off) materialize the duplicate for real.
  // Pruning here means the ids, the markdown and the payload all describe
  // one consistent read.
  const nested = new Set<string>()
  for (const result of validResults) {
    for (const row of result.data.blocks) {
      if (row.id !== result.id) nested.add(row.id)
    }
  }
  const roots = validResults.filter(result => !nested.has(result.id))

  return {
    markdown: roots.map(r => r.data.markdown).join('\n'),
    blocks: roots.flatMap(r => r.data.blocks),
    serializedIds: roots.map(r => r.id),
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
    cutId: uuidv4(),
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
 *  Pruning of ancestor+descendant pairs happens inside
 *  `serializeSelectedBlocks`, from the rows it reads — not as a separate
 *  pass beforehand. Two reads can disagree about the hierarchy (a
 *  sync-applied reparent between them), and then the ids, the markdown and
 *  the payload describe different sets.
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

  try {
    // The reads are inside the handled path too. `$mod+x` has already
    // claimed the gesture, and a rejected action promise is only logged by
    // `HotkeyReconciler` — so a hierarchy or serialization failure escaping
    // here means the user sees nothing at all: no toast, no clipboard, no
    // hint that the cut didn't happen.
    const data = await serializeSelectedBlocks([...blockIds], repo)
    // Every requested id must appear SOMEWHERE in what we serialized —
    // as a root, or nested inside one. Checked against the rows the
    // serialization actually read, so the hierarchy question is answered
    // by one snapshot: a separate pre-validation pass could prune B as
    // A's descendant while the subsequent read saw B already detached,
    // leaving a count that matched and a cut that silently dropped it.
    //
    // All-or-nothing, like `deleteBlocksThroughUi`: the caller clears the
    // whole selection on success, so a partial cut strands the missing
    // blocks with nothing telling the user.
    const covered = new Set(data.blocks.map(block => block.id))
    const missing = [...blockIds].filter(id => !covered.has(id))
    if (missing.length > 0) {
      throw new Error(`cut could not serialize ${missing.length} of ${blockIds.length} blocks`)
    }
    await writeToClipboard(data, {
      blockIds: data.serializedIds,
      workspaceId,
      intent: 'cut',
      cutId: uuidv4(),
    })
  } catch (error) {
    console.warn('[cut] failed; cut cancelled', error)
    showError("Couldn't cut — the clipboard was unavailable")
    return false
  }
  return true
}
