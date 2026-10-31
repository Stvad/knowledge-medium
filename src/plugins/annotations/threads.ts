/**
 * The thread writes: create, reply, resolve and reopen. The target block is
 * never written to here; accepting an edit suggestion (`suggestions.ts`) is
 * the one write that changes it.
 */

import {ChangeScope, propertyValue, type BlockData, type BlockReference, type Tx} from '@/data/api'
import {createChild} from '@/data/mutators'
import {isPropertyFieldRow, isPropertyValueRow} from '@/data/propertyChildren'
import {hasBlockType} from '@/data/properties'
import {parseExactReferenceBlockContent} from '@/data/referenceBlock'
import type {Repo} from '@/data/repo'
import {createTypedChild} from '@/data/typedRecords'
import {safeDecodeRowProperty} from '@/data/rowProperty'
import {hasLoneSurrogate} from '@/utils/string'
import {resolveAnchor, type RangeAnchor} from './anchor.ts'
import {commentsPageBlockId, getOrCreateCommentsPage} from './container.ts'
import {
  anchorFieldValues,
  annotationReplacementProp,
  annotationStatusProp,
  annotationTargetProp,
  THREAD_TYPE,
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
 *  property field or value row, which scope reads never descend into and whose
 *  content is an encoded property value. */
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
  if (await isPropertyFieldRow(tx, target) || await isPropertyValueRow(tx, target)) {
    throw new UnannotatableTargetError('A property row can’t be commented on.')
  }
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
  if (hasLoneSurrogate(anchor.quote)) throw new InvalidQuoteError('The quote cuts a character in half.')
  if (parseExactReferenceBlockContent(anchor.quote)?.fieldForm) {
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
   *  comments. */
  comment?: string
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

/** One undo step: the thread root and its first comment. A workspace's first
 *  comment also creates the container, outside the undo step.
 *
 *  The anchor must still resolve exact against the target as of the creating
 *  transaction, so a target that changed under the user refuses with
 *  `AnchorChangedError` rather than anchoring to the wrong text. */
export const createThread = async (
  repo: Repo,
  {targetId, anchor, comment, replacement}: CreateThreadArgs,
  options: CreateThreadOptions = {},
): Promise<CreatedThread> => {
  if (anchor) assertQuotable(anchor)
  if (replacement !== undefined) assertSuggestion(anchor, replacement)
  const target = await repo.load(targetId)
  if (!target) throw missingTarget(targetId)

  const container = await getOrCreateCommentsPage(repo, target.workspaceId)
  return repo.tx(async tx => {
    // The load above already refused a missing or deleted target; this also
    // catches a delete that lands between it and this tx.
    const current = await annotatableTarget(tx, targetId)
    if (anchor && resolveAnchor(current.content, anchor).state !== 'exact') {
      throw new AnchorChangedError(replacement === undefined
        ? undefined
        : 'The text changed since it was selected. Select it again and choose Suggest edit to selection.')
    }

    // Passed so the thread is discoverable as soon as this commits, without
    // waiting on the post-commit reference projection.
    const targetEdge: BlockReference = {
      id: targetId, alias: targetId, sourceField: annotationTargetProp.name,
    }
    const threadId = await createTypedChild(repo, tx, {
      parentId: container.id,
      content: anchor?.quote ?? '',
      types: [THREAD_TYPE],
      properties: [
        propertyValue(annotationTargetProp, targetId),
        propertyValue(annotationStatusProp, 'open'),
        ...(anchor ? anchorFieldValues(anchor) : []),
        ...(replacement !== undefined ? [propertyValue(annotationReplacementProp, replacement)] : []),
      ],
      references: [targetEdge],
    })
    const commentId = comment
      ? await tx.run(createChild, {parentId: threadId, content: comment})
      : null
    return {threadId, commentId}
  }, {
    scope: ChangeScope.BlockDefault,
    description: options.description ??
      (replacement !== undefined ? 'suggest edit' : anchor ? 'comment on selection' : 'comment on block'),
  })
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
