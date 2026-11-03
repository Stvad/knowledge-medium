/**
 * Commenting from outside an editor, as an agent does: the quote arrives as
 * text, not a selection, so where it sits is found in the target's current
 * content.
 */

import type {Repo} from '@/data/repo'
import {captureAnchor, type RangeAnchor} from './anchor.ts'
import {
  createThread,
  InvalidQuoteError,
  missingTarget,
  type CreatedThread,
  type CreateThreadOptions,
} from './threads.ts'

/** Every offset `quote` starts at, overlapping ones included, as the
 *  resolver searches. */
const occurrencesOf = (content: string, quote: string): number[] => {
  const starts: number[] = []
  for (let at = content.indexOf(quote); at >= 0; at = content.indexOf(quote, at + 1)) starts.push(at)
  return starts
}

/** Where the `occurrence`th (1-based) appearance of `quote` in `content`
 *  starts. Refuses a quote that is absent, and one that appears more than
 *  once unless `occurrence` picks it. */
const locateQuote = (content: string, quote: string, occurrence?: number): number => {
  // An empty quote occurs everywhere, and would never end the search.
  if (quote === '') throw new InvalidQuoteError('The quote is empty. Omit it to comment on the whole block.')
  const starts = occurrencesOf(content, quote)
  if (starts.length === 0) throw new InvalidQuoteError('The quote is not in the block’s current text.')
  if (occurrence === undefined && starts.length > 1) {
    throw new InvalidQuoteError(
      `The quote appears ${starts.length} times; pass occurrence (1–${starts.length}) to pick one, or quote more text.`,
    )
  }
  const index = (occurrence ?? 1) - 1
  if (!Number.isInteger(index) || index < 0 || index >= starts.length) {
    throw new InvalidQuoteError(`occurrence ${occurrence} is not between 1 and ${starts.length}.`)
  }
  return starts[index]
}

/** The anchor for that appearance, widened to whole reference spans as a
 *  selection is. */
export const anchorForQuote = (content: string, quote: string, occurrence?: number): RangeAnchor => {
  const start = locateQuote(content, quote, occurrence)
  return captureAnchor(content, start, start + quote.length)!
}

/** A replacement written for `quote` at `start`, carried over to the anchor
 *  it widened to: the text the widening added on either side is kept, so
 *  `Alice` → `Bob` inside `[[Alice Smith]]` becomes `[[Bob Smith]]`. */
const widenReplacement = (anchor: RangeAnchor, start: number, quote: string, replacement: string): string => {
  const before = start - anchor.quoteStart!
  return anchor.quote.slice(0, before) + replacement + anchor.quote.slice(before + quote.length)
}

export interface AddCommentArgs {
  targetId: string
  /** Text of the target to anchor to; absent comments on the whole block. */
  quote?: string
  /** Which appearance of `quote`, from 1; required when it appears twice. */
  occurrence?: number
  /** The first comment; absent or empty makes a highlight. */
  comment?: string
  /** Makes the thread an edit suggestion: the new text for `quote` (for
   *  just the quoted part, when the quote is widened to a whole link). */
  replacement?: string
}

/** A thread on `targetId`, anchored to `quote` as the target reads now. If the
 *  target changes before the write, `createThread` refuses rather than anchor
 *  to the wrong text. */
export const addComment = async (
  repo: Repo,
  {targetId, quote, occurrence, comment, replacement}: AddCommentArgs,
  options: CreateThreadOptions = {},
): Promise<CreatedThread> => {
  if (quote === undefined && occurrence !== undefined) {
    throw new InvalidQuoteError('occurrence picks among the appearances of a quote; pass the quote too.')
  }
  const target = await repo.load(targetId)
  if (!target) throw missingTarget(targetId)
  if (quote === undefined) return createThread(repo, {targetId, anchor: null, comment, replacement}, options)
  const start = locateQuote(target.content, quote, occurrence)
  const anchor = captureAnchor(target.content, start, start + quote.length)!
  return createThread(repo, {
    targetId,
    anchor,
    comment,
    replacement: replacement === undefined ? undefined : widenReplacement(anchor, start, quote, replacement),
  }, options)
}
