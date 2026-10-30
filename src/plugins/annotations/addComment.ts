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

/** The anchor for the `occurrence`th (1-based) appearance of `quote` in
 *  `content`, widened to whole reference spans as a selection is. Refuses a
 *  quote that is absent, and one that appears more than once unless
 *  `occurrence` picks it. */
export const anchorForQuote = (content: string, quote: string, occurrence?: number): RangeAnchor => {
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
  const start = starts[index]
  return captureAnchor(content, start, start + quote.length)!
}

export interface AddCommentArgs {
  targetId: string
  /** Text of the target to anchor to; absent comments on the whole block. */
  quote?: string
  /** Which appearance of `quote`, from 1; required when it appears twice. */
  occurrence?: number
  /** The first comment; absent or empty makes a highlight. */
  comment?: string
}

/** A thread on `targetId`, anchored to `quote` as the target reads now. If the
 *  target changes before the write, `createThread` refuses rather than anchor
 *  to the wrong text. */
export const addComment = async (
  repo: Repo,
  {targetId, quote, occurrence, comment}: AddCommentArgs,
  options: CreateThreadOptions = {},
): Promise<CreatedThread> => {
  if (quote === undefined && occurrence !== undefined) {
    throw new InvalidQuoteError('occurrence picks among the appearances of a quote; pass the quote too.')
  }
  const target = await repo.load(targetId)
  if (!target) throw missingTarget(targetId)
  const anchor = quote === undefined ? null : anchorForQuote(target.content, quote, occurrence)
  return createThread(repo, {targetId, anchor, comment}, options)
}
