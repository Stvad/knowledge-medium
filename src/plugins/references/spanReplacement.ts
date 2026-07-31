/**
 * The span-replacement LADDER: given an alias that is losing its
 * binding, which rendering should replace it?
 *
 * The round-trip guard primitives live in `referenceParser.ts` because
 * they are pure grammar — render, parse back, compare. This is the
 * policy layer on top: which form we PREFER, and what we do when the
 * preferred one can't carry the span. That is app policy plus
 * processor-named diagnostics, so it sits beside the processors rather
 * than in the grammar module.
 *
 * Both callers (alias rename, merge retarget) want the same two steps
 * with three different parameters, and previously each spelled the
 * ladder out with its own near-identical `console.warn` blocks. Sharing
 * it keeps the fallback policy in one place — and makes the one real
 * difference between them (which label gets pinned) visible at the call
 * site instead of buried in duplicated prose.
 */

import {
  faithfulWikilinkReplacement,
  pinnedSpanReplacement,
  type SpanReplacement,
} from './referenceParser.ts'

export interface SpanReplacementRequest {
  /** Alias to try in late-binding `[[…]]` form, or `null` to skip
   *  straight to pinning. The rename ladder passes the newly added
   *  alias only on a clean 1-for-1 swap; merge always has a candidate. */
  wikilinkAlias: string | null
  /** Display text for the pinned `[label](((id)))` fallback. NOT
   *  interchangeable with `wikilinkAlias`: rename pins the REMOVED alias
   *  (preserving what the source author wrote), while an alias-collision
   *  merge pins the SURVIVING alias (deliberately re-titling the span). */
  pinLabel: string
  /** Block the pinned form binds to. */
  targetId: string
  /** Processor name, for the diagnostics below. */
  context: string
}

/** Run the ladder. `null` means no rendering could carry this span —
 *  the caller must leave it alone rather than splice text that doesn't
 *  parse, which would destroy the link outright. Reported here so
 *  callers don't each restate it. */
export const preferredSpanReplacement = (
  request: SpanReplacementRequest,
): SpanReplacement | null => {
  const {wikilinkAlias, pinLabel, targetId, context} = request
  if (wikilinkAlias !== null) {
    const wikilink = faithfulWikilinkReplacement(wikilinkAlias)
    if (wikilink !== null) return wikilink
  }
  const pinned = pinnedSpanReplacement(pinLabel, targetId)
  if (pinned === null) {
    console.warn(
      `[${context}] cannot pin a span for "${pinLabel}" to target "${targetId}" ` +
      `(target is not UUID-shaped, or the label would smuggle a wikilink ` +
      `opener); leaving those spans unrewritten`,
    )
    return null
  }
  if (pinned.lossyLabel) {
    console.warn(
      `[${context}] pinned span for "${pinLabel}" displays sanitized text ` +
      `(\`]\`/newline stripped, whitespace trimmed); link preserved`,
    )
  }
  return pinned
}
