/**
 * The thread writes: create, reply, resolve and reopen. The target block is
 * never written to.
 */

import {ChangeScope, propertyValue, type BlockReference} from '@/data/api'
import {createChild} from '@/data/mutators'
import {isPropertyFieldRow, isPropertyValueRow} from '@/data/propertyChildren'
import {parseExactReferenceBlockContent} from '@/data/referenceBlock'
import type {Repo} from '@/data/repo'
import {createTypedChild} from '@/data/typedRecords'
import {hasLoneSurrogate} from '@/utils/string'
import {resolveAnchor, type RangeAnchor} from './anchor.ts'
import {getOrCreateCommentsPage} from './container.ts'
import {
  annotationQuotePrefixProp,
  annotationQuoteStartProp,
  annotationQuoteSuffixProp,
  annotationStatusProp,
  annotationTargetProp,
  THREAD_TYPE,
  type ThreadStatus,
} from './schema.ts'

/** The quoted text is no longer exactly where the selection found it: the
 *  target changed between selecting and submitting. Nothing was written, so a
 *  caller keeps its draft and lets the user reselect. */
export class AnchorChangedError extends Error {
  constructor() {
    super('The text changed since it was selected. Select it again to comment.')
    this.name = 'AnchorChangedError'
  }
}

/** The target cannot carry a thread: it is missing or deleted, or it is a
 *  property field or value row, which scope reads never descend into and whose
 *  content is an encoded property value. */
export class UnannotatableTargetError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'UnannotatableTargetError'
  }
}

/** The selection can't be a thread's quote. The quote becomes the root's
 *  content, so it must be text a block can hold as its own: never a `::` field
 *  marker, which would make the root a property field row of the container. */
export class InvalidQuoteError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'InvalidQuoteError'
  }
}

/** A refusal `createThread` makes before writing, for a caller to show. */
export const isThreadRefusal = (error: unknown): error is Error =>
  error instanceof AnchorChangedError || error instanceof UnannotatableTargetError || error instanceof InvalidQuoteError

export const missingTarget = (targetId: string) => new UnannotatableTargetError(`Block ${targetId} is missing or deleted.`)

/** Anchors come from `captureAnchor` in the app, but agents and the bridge
 *  build their own. */
const assertQuotable = (anchor: RangeAnchor): void => {
  if (anchor.quote === '') throw new InvalidQuoteError('The quote is empty.')
  if (anchor.quoteStart !== undefined && !(Number.isInteger(anchor.quoteStart) && anchor.quoteStart >= 0)) {
    throw new InvalidQuoteError(`quoteStart ${anchor.quoteStart} is not a position in the text.`)
  }
  if (hasLoneSurrogate(anchor.quote)) throw new InvalidQuoteError('The quote cuts a character in half.')
  if (parseExactReferenceBlockContent(anchor.quote)?.fieldForm) {
    throw new InvalidQuoteError('A property field marker can\u2019t be quoted on its own.')
  }
}

export interface CreateThreadArgs {
  targetId: string
  /** null comments on the whole block. */
  anchor: RangeAnchor | null
  /** The first comment. Absent or empty makes a highlight: a thread with no
   *  comments. */
  comment?: string
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
  {targetId, anchor, comment}: CreateThreadArgs,
  options: CreateThreadOptions = {},
): Promise<CreatedThread> => {
  if (anchor) assertQuotable(anchor)
  const target = await repo.load(targetId)
  if (!target) throw missingTarget(targetId)

  const container = await getOrCreateCommentsPage(repo, target.workspaceId)
  return repo.tx(async tx => {
    const current = await tx.get(targetId)
    // DEFENCE IN DEPTH: the load above already refuses a missing or deleted
    // target; this catches a delete that lands between it and this tx.
    if (!current || current.deleted) throw missingTarget(targetId)
    if (await isPropertyFieldRow(tx, current) || await isPropertyValueRow(tx, current)) {
      throw new UnannotatableTargetError('A property row can’t be commented on.')
    }
    if (anchor && resolveAnchor(current.content, anchor).state !== 'exact') {
      throw new AnchorChangedError()
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
        ...(anchor ? [
          propertyValue(annotationQuoteStartProp, anchor.quoteStart),
          propertyValue(annotationQuotePrefixProp, anchor.prefix),
          propertyValue(annotationQuoteSuffixProp, anchor.suffix),
        ] : []),
      ],
      references: [targetEdge],
    })
    const commentId = comment
      ? await tx.run(createChild, {parentId: threadId, content: comment})
      : null
    return {threadId, commentId}
  }, {
    scope: ChangeScope.BlockDefault,
    description: options.description ?? (anchor ? 'comment on selection' : 'comment on block'),
  })
}

/** An empty reply under the comment being answered (or under the root, for a
 *  reply to the thread), revealed if that comment is collapsed. The caller
 *  focuses it; from there it is ordinary block editing. */
export const replyTo = (repo: Repo, parentId: string): Promise<string> =>
  repo.mutate.createChild({parentId, position: {kind: 'last'}, revealParent: true})

export const setThreadStatus = (repo: Repo, threadId: string, status: ThreadStatus): Promise<void> =>
  repo.tx(
    tx => tx.setProperty(threadId, annotationStatusProp, status),
    {scope: ChangeScope.BlockDefault, description: status === 'resolved' ? 'resolve thread' : 'reopen thread'},
  )
