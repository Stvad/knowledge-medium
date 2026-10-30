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
import type {Repo} from '@/data/repo'
import {resolveAnchor} from './anchor.ts'
import {annotationStatusProp, threadAnchorOf, threadReplacementOf} from './schema.ts'
import {InvalidSuggestionError, threadAndTarget} from './threads.ts'

/** The quote is no longer exactly where it was suggested. Nothing was
 *  written; re-anchoring ("confirm position", or reselecting) makes it
 *  acceptable again. */
export class SuggestionChangedError extends Error {
  constructor() {
    super('The text changed since this was suggested. Confirm its position, or reselect it, to accept.')
    this.name = 'SuggestionChangedError'
  }
}

/** Splice the replacement over the quote and mark the thread accepted, as
 *  one undo step.
 *
 *  The anchor must resolve exact as of this transaction, and is never
 *  rewritten: exactness is also what refuses a second application. A
 *  duplicate of an applied suggestion, or the same one reopened, still finds
 *  its quote at its offset, but the text beside it is no longer the stored
 *  context (`Thursday` → `Thursday 9am` leaves ` 9am…` after the quote), so
 *  it resolves moved and refuses instead of writing the replacement twice. */
export const acceptSuggestion = (repo: Repo, threadId: string): Promise<void> =>
  repo.tx(async tx => {
    const {root, target} = await threadAndTarget(tx, threadId)
    const replacement = threadReplacementOf(root)
    const anchor = threadAnchorOf(root)
    if (replacement === undefined || anchor.kind !== 'range') {
      throw new InvalidSuggestionError('This thread is not an edit suggestion.')
    }
    const resolved = resolveAnchor(target.content, anchor)
    if (resolved.state !== 'exact') throw new SuggestionChangedError()
    const content = target.content
    await tx.update(target.id, {content: content.slice(0, resolved.from) + replacement + content.slice(resolved.to)})
    await tx.setProperty(threadId, annotationStatusProp, 'accepted')
  }, {scope: ChangeScope.BlockDefault, description: 'accept suggestion'})
