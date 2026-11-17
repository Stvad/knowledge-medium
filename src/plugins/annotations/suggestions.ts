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
import {recaptureAnchor, resolveAnchor, type RangeAnchor} from './anchor.ts'
import {annotationStatusProp, THREAD_TYPE, threadIsOpen, threadSuggestionOf} from './schema.ts'
import {AnchorChangedError, assertSuggestion, InvalidSuggestionError, threadAndTarget} from './threads.ts'

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

/** A relocated quote must be unique and still share context with its anchor.
 *  Matching replacement text in that context can be an already-applied copy;
 *  leave that case for explicit position confirmation instead of jumping to
 *  another occurrence of the old quote. */
const suggestionRange = (content: string, anchor: RangeAnchor, replacement: string): {from: number; to: number} => {
  const resolved = resolveAnchor(content, anchor)
  if (resolved.state === 'stale') {
    throw new AnchorChangedError('The original text could not be located reliably. Select the text this suggestion should replace.')
  }
  if (resolved.state === 'moved') {
    if (content.indexOf(anchor.quote) !== content.lastIndexOf(anchor.quote)) {
      throw new AnchorChangedError('This text appears more than once. Check its position before accepting.')
    }
    if (resolveAnchor(content, {...anchor, quote: replacement}).state !== 'stale') {
      throw new AnchorChangedError('The suggested replacement is already present nearby. Check its position before accepting.')
    }
  }
  if (!recaptureAnchor(content, resolved.from, anchor.quote)) {
    throw new AnchorChangedError('The text is now part of a larger reference. Select the whole reference before accepting.')
  }
  return resolved
}

/** Splice the replacement over the quote and mark the thread accepted, as
 *  one undo step. Resolve against this transaction's content; keep the stored
 *  anchor as the original quote and context for the suggestion's history. */
export const acceptSuggestion = (repo: Repo, threadId: string): Promise<void> =>
  repo.tx(async tx => {
    const {root, target} = await threadAndTarget(tx, threadId)
    const suggestion = threadSuggestionOf(root)
    if (!suggestion) throw new InvalidSuggestionError('This thread is not an edit suggestion.')
    assertSuggestion(suggestion.anchor, suggestion.replacement)
    // The card offers Accept only while open, but may be stale.
    if (!threadIsOpen(root)) throw new InvalidSuggestionError('This suggestion is closed.')
    const resolved = suggestionRange(target.content, suggestion.anchor, suggestion.replacement)
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
