/**
 * The thread writes: create, reply, resolve and reopen. The target block is
 * never written to here; accepting an edit suggestion (`suggestions.ts`) is
 * the one write that changes it.
 */

import {ChangeScope, propertyValue, type BlockData, type Tx} from '@/data/api'
import {createChild, move} from '@/data/mutators'
import {hasBlockType} from '@/data/properties'
import {verbatimValueTextProblem} from '@/data/propertyChildren'
import type {Repo} from '@/data/repo'
import {createTypedChild} from '@/data/typedRecords'
import {safeDecodeRowProperty} from '@/data/rowProperty'
import {hasLoneSurrogate} from '@/utils/string'
import {resolveAnchor, type RangeAnchor} from './anchor.ts'
import {commentsPageBlockId, getOrCreateCommentsPage} from './container.ts'
import {
  anchorFieldValues,
  annotationReplacementProp,
  annotationSourceContentProp,
  annotationStatusProp,
  annotationTargetProp,
  THREAD_TYPE,
  threadTargetEdge,
  threadTargetIdOf,
  type ThreadStatus,
} from './schema.ts'

/** A refusal a thread write makes before writing anything, for a caller to
 *  show. Every refusal extends it. */
export class ThreadRefusal extends Error {}

/** The quoted text is no longer exactly where the anchor was captured: the
 *  target changed since. Nothing was written, so a caller keeps its draft and
 *  lets the user reselect, or re-anchor. */
export class AnchorChangedError extends ThreadRefusal {
  constructor(message = 'The text changed since it was selected. Select it again to comment.') {
    super(message)
    this.name = 'AnchorChangedError'
  }
}

/** The target cannot carry a thread: it is missing or deleted, or it is a
 *  comment thread root / its container. Property rows are ordinary blocks and
 *  can be annotated like any other target. */
export class UnannotatableTargetError extends ThreadRefusal {
  constructor(reason: string) {
    super(reason)
    this.name = 'UnannotatableTargetError'
  }
}

/** The selection can't be a thread's quote. The quote becomes the root's
 *  content, so it must be text a block can hold as its own: never a `::` field
 *  marker, which would make the root a property field row of the container. */
export class InvalidQuoteError extends ThreadRefusal {
  constructor(reason: string) {
    super(reason)
    this.name = 'InvalidQuoteError'
  }
}

/** The thread can't be, or isn't, an edit suggestion, or can't be applied:
 *  one needs a quote to replace and a replacement that changes it, in a way
 *  its anchor can tell apart from the original. */
export class InvalidSuggestionError extends ThreadRefusal {
  constructor(reason: string) {
    super(reason)
    this.name = 'InvalidSuggestionError'
  }
}

export const isThreadRefusal = (error: unknown): error is ThreadRefusal => error instanceof ThreadRefusal

export const missingTarget = (targetId: string) => new UnannotatableTargetError(`Block ${targetId} is missing or deleted.`)

/** The target as of `tx`, refused unless it can carry a thread. Every write
 *  that reads a target checks it here, inside its own transaction. */
export const annotatableTarget = async (tx: Tx, targetId: string): Promise<BlockData> => {
  const target = await tx.get(targetId)
  if (!target || target.deleted) throw missingTarget(targetId)
  if (hasBlockType(target, THREAD_TYPE) || target.id === commentsPageBlockId(target.workspaceId)) {
    throw new UnannotatableTargetError('A comment thread, or the page that holds them, can’t be commented on.')
  }
  return target
}

/** A live thread root, and its target as `annotatableTarget` admits it, both
 *  as of `tx`. */
export const threadAndTarget = async (tx: Tx, threadId: string): Promise<{root: BlockData; target: BlockData}> => {
  const root = await tx.get(threadId)
  if (!root || root.deleted || !hasBlockType(root, THREAD_TYPE)) {
    throw new UnannotatableTargetError(`Thread ${threadId} is missing or deleted.`)
  }
  return {root, target: await annotatableTarget(tx, threadTargetIdOf(root) ?? '')}
}

/** Anchors come from `captureAnchor` in the app, but agents and the bridge
 *  build their own. */
export const assertQuotable = (anchor: RangeAnchor): void => {
  if (anchor.quote === '') throw new InvalidQuoteError('The quote is empty.')
  if (anchor.quoteStart !== undefined && !(Number.isInteger(anchor.quoteStart) && anchor.quoteStart >= 0)) {
    throw new InvalidQuoteError(`quoteStart ${anchor.quoteStart} is not a position in the text.`)
  }
  const problem = verbatimValueTextProblem(anchor.quote)
  if (problem === 'lone-surrogate') throw new InvalidQuoteError('The quote cuts a character in half.')
  if (problem === 'field-form') {
    throw new InvalidQuoteError('A property field marker can\u2019t be quoted on its own.')
  }
}

/** A suggestion replaces quoted text, so its anchor is a range: when it is
 *  made and whenever it is re-anchored. */
export const assertSuggestionAnchor = (anchor: RangeAnchor | null, replacement: string | undefined): void => {
  if (replacement !== undefined && !anchor) {
    throw new InvalidSuggestionError('A suggestion needs quoted text to replace.')
  }
}

/** What every suggestion's replacement must be, checked when it is made and
 *  again when it is accepted (a hand-set replacement skips creation). */
export const assertSuggestion = (anchor: RangeAnchor | null, replacement: string): void => {
  assertSuggestionAnchor(anchor, replacement)
  if (!anchor) return
  if (replacement === '') {
    throw new InvalidSuggestionError('The replacement is empty. To suggest deleting text, replace a slightly wider span.')
  }
  if (replacement === anchor.quote) throw new InvalidSuggestionError('The replacement is the same as the quoted text.')
  if (hasLoneSurrogate(replacement)) throw new InvalidSuggestionError('The replacement cuts a character in half.')
}

export interface CreateThreadArgs {
  targetId: string
  /** null comments on the whole block. */
  anchor: RangeAnchor | null
  /** The first comment. Absent or empty makes a highlight: a thread with no
   *  comments, unless `emptyComment` asks for one to be written in. */
  comment?: string
  /** Write an empty first comment for the user to fill in (`startComment`). */
  emptyComment?: boolean
  /** Makes the thread an edit suggestion: "replace the quote with this". */
  replacement?: string
}

export interface CreatedThread {
  threadId: string
  commentId: string | null
}

export interface CreateThreadOptions {
  /** The transaction's description; an agent write names its own verb. */
  description?: string
}

const commentsPageForTarget = async (repo: Repo, targetId: string) => {
  // A pooled reader can lag a local commit. Use the block handle's committed
  // snapshot for the workspace lookup. The write checks the live row in annotatableTarget.
  const target = await repo.block(targetId).load()
  if (!target) throw missingTarget(targetId)
  return getOrCreateCommentsPage(repo, target.workspaceId)
}

/** An open thread root on `targetId`, filed under the comments page. */
const writeThreadRoot = (
  repo: Repo,
  tx: Tx,
  containerId: string,
  {targetId, anchor, replacement}: Pick<CreateThreadArgs, 'targetId' | 'anchor' | 'replacement'>,
): Promise<string> =>
  createTypedChild(repo, tx, {
    parentId: containerId,
    content: anchor?.quote ?? '',
    types: [THREAD_TYPE],
    properties: [
      propertyValue(annotationTargetProp, targetId),
      propertyValue(annotationStatusProp, 'open'),
      ...(anchor ? anchorFieldValues(anchor) : []),
      ...(replacement !== undefined ? [propertyValue(annotationReplacementProp, replacement)] : []),
    ],
    references: [threadTargetEdge(targetId)],
  })

/** One undo step: the thread root and its first comment. A workspace's first
 *  comment also creates the container, outside the undo step.
 *
 *  The anchor must still resolve exact against the target as of the creating
 *  transaction, so a target that changed under the user refuses with
 *  `AnchorChangedError` rather than anchoring to the wrong text. */
export const createThread = async (
  repo: Repo,
  {targetId, anchor, comment, emptyComment, replacement}: CreateThreadArgs,
  options: CreateThreadOptions = {},
): Promise<CreatedThread> => {
  if (anchor) assertQuotable(anchor)
  if (replacement !== undefined) assertSuggestion(anchor, replacement)
  const container = await commentsPageForTarget(repo, targetId)
  return repo.tx(async tx => {
    const current = await annotatableTarget(tx, targetId)
    if (anchor && resolveAnchor(current.content, anchor).state !== 'exact') {
      throw new AnchorChangedError(replacement === undefined
        ? undefined
        : 'The text changed since it was selected. Select it again and choose Suggest edit to selection.')
    }

    const threadId = await writeThreadRoot(repo, tx, container.id, {targetId, anchor, replacement})
    if (replacement !== undefined && anchor) {
      await tx.setProperty(threadId, annotationSourceContentProp, current.content)
    }
    const commentId = comment || emptyComment
      ? await tx.run(createChild, {parentId: threadId, content: comment ?? ''})
      : null
    return {threadId, commentId}
  }, {
    scope: ChangeScope.BlockDefault,
    description: options.description ??
      (replacement !== undefined ? 'suggest edit' : anchor ? 'comment on selection' : 'comment on block'),
  })
}

/** The thread `block` is a comment in, given its ancestors nearest first:
 *  the nearest thread root above it. Null for a thread root itself, a block
 *  in no thread, and a property row (or a block inside one), which belongs to
 *  its owner rather than being a comment. */
export const commentThreadOf = (block: BlockData, ancestors: readonly BlockData[]): BlockData | null => {
  if (hasBlockType(block, THREAD_TYPE)) return null
  for (const at of [block, ...ancestors]) {
    if (at.isFieldForm === true) return null
    if (hasBlockType(at, THREAD_TYPE)) return at
  }
  return null
}

/** `commentThreadOf` as of `tx`. */
const commentThreadInTx = async (tx: Tx, id: string): Promise<BlockData | null> => {
  const block = await tx.get(id)
  if (!block || block.deleted) return null
  const ancestors: BlockData[] = []
  for (let at = block.parentId; at !== null && ancestors.length < 100;) {
    const parent = await tx.get(at)
    if (!parent) break
    ancestors.push(parent)
    if (hasBlockType(parent, THREAD_TYPE)) break
    at = parent.parentId
  }
  return commentThreadOf(block, ancestors)
}

/** The blocks a comment links by its content. Property edges (credit, typed
 *  pointers) are not links. */
export const linkedBlockIds = (comment: Pick<BlockData, 'references'>): string[] =>
  [...new Set(comment.references.filter(ref => !ref.sourceField).map(ref => ref.id))]

/** Would a thread on `targetId` render inside `commentId`'s own subtree? A
 *  thread's card renders inside the card of every thread its target is in,
 *  out to the page, so any hop of that chain inside the comment would put the
 *  comment inside itself. */
const rendersInside = async (tx: Tx, targetId: string, commentId: string): Promise<boolean> => {
  const seen = new Set<string>()
  for (let at: string | undefined = targetId; at !== undefined && !seen.has(at);) {
    if (await tx.isDescendantOf(at, commentId)) return true
    seen.add(at)
    const thread = await commentThreadInTx(tx, at)
    at = thread ? threadTargetIdOf(thread) : undefined
  }
  return false
}

export interface MoveToOwnThreadArgs {
  commentId: string
  /** The block the new thread is on, as a whole. */
  targetId: string
}

/** Move a comment, with its replies, out of its thread to be the first
 *  comment of a new thread on the whole of `targetId`. One undo step; returns
 *  the new thread's root. */
export const moveToOwnThread = async (repo: Repo, {commentId, targetId}: MoveToOwnThreadArgs): Promise<string> => {
  const container = await commentsPageForTarget(repo, targetId)
  return repo.tx(async tx => {
    const thread = await commentThreadInTx(tx, commentId)
    if (!thread) throw new ThreadRefusal('Only a comment in a thread can move to a thread of its own.')
    // Its thread would be left with nothing in it. The root's own property
    // rows are not comments.
    const comment = (await tx.get(commentId))!
    if (comment.parentId === thread.id && (await tx.childrenOf(thread.id, undefined, {propertyChildren: 'none'})).length === 1) {
      throw new ThreadRefusal('This is its thread’s only comment, so it is a thread of its own already.')
    }
    await annotatableTarget(tx, targetId)
    if (await rendersInside(tx, targetId, commentId)) {
      throw new UnannotatableTargetError('A comment can’t move to a thread shown inside itself or its replies.')
    }
    const threadId = await writeThreadRoot(repo, tx, container.id, {targetId, anchor: null})
    await tx.run(move, {id: commentId, parentId: threadId, position: {kind: 'first'}})
    return threadId
  }, {scope: ChangeScope.BlockDefault, description: 'move comment to its own thread'})
}

/** The blocks a comment links on the page its thread is on: the likely
 *  targets for `moveToOwnThread`, in link order. */
export const ownThreadTargets = async (repo: Repo, commentId: string): Promise<string[]> => {
  const comment = await repo.load(commentId)
  if (!comment) return []
  const pathOf = async (id: string) => (await repo.query.ancestors({id}).load()).ancestors
  const thread = commentThreadOf(comment, await pathOf(commentId))
  const threadTarget = thread && threadTargetIdOf(thread)
  if (!threadTarget) return []
  const pageOf = async (id: string) => (await pathOf(id)).at(-1)?.id ?? id
  const page = await pageOf(threadTarget)
  const linked = linkedBlockIds(comment)
  const onPage = await Promise.all(linked.map(async id => {
    const block = await repo.load(id)
    return !!block && !block.deleted && !hasBlockType(block, THREAD_TYPE) && await pageOf(id) === page
  }))
  return linked.filter((_, i) => onPage[i])
}

/** An empty reply under the comment being answered (or under the root, for a
 *  reply to the thread), revealed if that comment is collapsed. The caller
 *  focuses it; from there it is ordinary block editing. */
export const replyTo = (repo: Repo, parentId: string): Promise<string> =>
  repo.mutate.createChild({parentId, position: {kind: 'last'}, revealParent: true})

/** A suggestion's own statuses are set by `acceptSuggestion` and
 *  `rejectSuggestion`, which check it is still open. */
type SettableStatus = Exclude<ThreadStatus, 'accepted' | 'rejected'>

const STATUS_DESCRIPTIONS: Record<SettableStatus, string> = {
  open: 'reopen thread',
  resolved: 'resolve thread',
}

/** An accepted suggestion keeps its status: its change is in the text, and
 *  reopened (directly, or after a resolve) it could be applied again
 *  elsewhere once re-anchored. Undo reverts an accept, change and status
 *  together. */
export const setThreadStatus = (repo: Repo, threadId: string, status: SettableStatus): Promise<void> =>
  repo.tx(async tx => {
    const root = await tx.get(threadId)
    if (root && safeDecodeRowProperty(root, annotationStatusProp) === 'accepted') {
      throw new InvalidSuggestionError('An accepted suggestion stays accepted: its change is already in the text.')
    }
    await tx.setProperty(threadId, annotationStatusProp, status)
  }, {scope: ChangeScope.BlockDefault, description: STATUS_DESCRIPTIONS[status]})
