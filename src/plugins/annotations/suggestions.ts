/**
 * Edit suggestions: a thread whose root carries `annotation:replacement`,
 * "replace the quoted text with this". Created like any thread
 * (`createThread` with a replacement); rejecting only sets the status.
 *
 * Accepting is a person's click in the card, never a programmatic call: the
 * click blurs the target's editor, whose blur flushes its pending write onto
 * the write lock ahead of the accept's transaction, so a debounced write can't
 * land stale text over the accepted change. Agents propose; an agent that
 * should change text directly edits the block.
 */

import {ChangeScope} from '@/data/api'
import {hasBlockType} from '@/data/properties'
import {parseExactReferenceBlockContent} from '@/data/referenceBlock'
import type {Repo} from '@/data/repo'
import {resolveAnchor, type RangeAnchor} from './anchor.ts'
import {annotationStatusProp, THREAD_TYPE, threadIsOpen, threadSuggestionOf} from './schema.ts'
import {AnchorChangedError, InvalidSuggestionError, threadAndTarget} from './threads.ts'

/** Does the text around `from` already read as `replacement`, with the quote
 *  where the replacement holds it? Then this change is already there: a copy
 *  of an applied suggestion that "confirm position" moved onto the applied
 *  text resolves exact again. */
const readsAsApplied = (content: string, from: number, quote: string, replacement: string): boolean => {
  for (let at = replacement.indexOf(quote); at >= 0 && at <= from; at = replacement.indexOf(quote, at + 1)) {
    if (content.startsWith(replacement, from - at)) return true
  }
  return false
}

/** `content` with `replacement` spliced over the exact range of `anchor`, or
 *  a refusal. Two applications must stay distinguishable, so the change must
 *  not already be there, and the anchor must not still resolve exact
 *  afterwards (text that repeats around the quote). Nor may the change turn
 *  the block into a property field row. */
export const appliedContent = (
  content: string,
  {from, to}: {from: number; to: number},
  anchor: RangeAnchor,
  replacement: string,
): string => {
  if (readsAsApplied(content, from, anchor.quote, replacement)) {
    throw new InvalidSuggestionError('The text already reads as this suggestion.')
  }
  const next = content.slice(0, from) + replacement + content.slice(to)
  if (resolveAnchor(next, anchor).state === 'exact') {
    throw new InvalidSuggestionError(
      'The text around this suggestion repeats, so accepting it could not be told from accepting it twice. Edit the block directly.',
    )
  }
  if (parseExactReferenceBlockContent(next)?.fieldForm) {
    throw new InvalidSuggestionError('Accepting this would turn the block into a property field.')
  }
  return next
}

/** Splice the replacement over the quote and mark the thread accepted, as
 *  one undo step. The anchor must resolve exact as of this transaction and is
 *  never rewritten: exactness, with `appliedContent`'s refusals, is what
 *  stops a duplicate, or this thread reopened, from applying twice. */
export const acceptSuggestion = (repo: Repo, threadId: string): Promise<void> =>
  repo.tx(async tx => {
    const {root, target} = await threadAndTarget(tx, threadId)
    const suggestion = threadSuggestionOf(root)
    if (!suggestion) throw new InvalidSuggestionError('This thread is not an edit suggestion.')
    // The card offers Accept only while open, but may be stale.
    if (!threadIsOpen(root)) throw new InvalidSuggestionError('This suggestion is closed. Reopen it to accept it.')
    const resolved = resolveAnchor(target.content, suggestion.anchor)
    if (resolved.state !== 'exact') {
      throw new AnchorChangedError('The text changed since this was suggested. Confirm its position, or reselect it, to accept.')
    }
    await tx.update(target.id, {content: appliedContent(target.content, resolved, suggestion.anchor, suggestion.replacement)})
    await tx.setProperty(threadId, annotationStatusProp, 'accepted')
  }, {scope: ChangeScope.BlockDefault, description: 'accept suggestion'})

/** Close an open suggestion as rejected, as one undo step. Only an open one,
 *  checked in this transaction: a click queued behind an accept must not mark
 *  the change it just applied as rejected. */
export const rejectSuggestion = (repo: Repo, threadId: string): Promise<void> =>
  repo.tx(async tx => {
    const root = await tx.get(threadId)
    if (!root || root.deleted || !hasBlockType(root, THREAD_TYPE) || !threadIsOpen(root)) {
      throw new InvalidSuggestionError('This suggestion is no longer open.')
    }
    await tx.setProperty(threadId, annotationStatusProp, 'rejected')
  }, {scope: ChangeScope.BlockDefault, description: 'reject suggestion'})
