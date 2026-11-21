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

import { FIELD_FORM_MARKER, parseExactReferenceBlockContent } from '@/data/referenceBlock'
import {
  canonicalIdSpanReplacement,
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
  /** The span is the WHOLE content of a MARKED row (`::[[α]]`) — a
   *  property field row addressing its definition by NAME (§7/§9).
   *
   *  Changes only the fallback tier, to the canonical id form `((A))`
   *  with no label (§11 group 2 / #443: "its lossy-name fallback for
   *  marked rows is canonical `::((A))`, never a pinned label"). The
   *  wikilink tier still runs first and still wins a clean 1-for-1
   *  rename — id-carrying rows are identity-pinned, NAME rows follow the
   *  living name, and a marked name row is still a name row.
   *
   *  Two reasons it isn't just cosmetic. A field row displays its
   *  property name, resolved through the definition the id points at, so
   *  a pinned label is text the row never renders — noise in the source
   *  and in an export. And having no label means nothing to sanitize: an
   *  alias containing `]` pins only as `[ab](((A)))`, a silently changed
   *  display the pinned tier has to report, whereas the canonical form
   *  loses nothing and reports nothing.
   *
   *  (`pinnedSpanReplacement`'s other refusal — a label smuggling a `[[`
   *  opener — is NOT reachable from rename, whose pin label is the
   *  REMOVED alias: an alias containing `[[` cannot be written as a
   *  wikilink that parses back to it, so no edge naming it ever exists to
   *  enumerate. It stays reachable for merge, which pins an unrelated
   *  surviving alias.) */
  markedRow?: boolean
  /** Processor name, for the diagnostics below. */
  context: string
}

/** The marked-row fallback tier: `((A))`, checked against BOTH readers of
 *  the rewritten row, because they are separate parsers over the same text
 *  and a marked row needs both to agree.
 *
 *  `canonicalIdSpanReplacement` asks the INLINE grammar — the one that
 *  produces the `block_references` edge the rewriter is swapping in
 *  lockstep with the content. It is UUID-only, so a target with a
 *  caller-supplied non-UUID id fails here, and must: writing an entry for
 *  an edge the re-parse won't produce is the phantom-edge failure
 *  `splitBySurvivingSpan` exists to prevent.
 *
 *  Then `parseExactReferenceBlockContent` asks the WHOLE-BLOCK grammar —
 *  the one behind `reference_target_id` / `is_field_form`, which is what
 *  makes the row a field row at all. That leg is DEFENCE IN DEPTH, not
 *  load-bearing: the two grammars are deliberate mirrors of each other
 *  (`referenceBlock.ts` says so), so today anything clearing the inline
 *  check clears this one too and no test can pin it — deleting it fails
 *  nothing. It stays because the mirroring is by hand and a drift would
 *  otherwise land as a marked row that reads back as prose. */
const markedRowReplacement = (
  targetId: string,
  context: string,
): SpanReplacement | null => {
  const canonical = canonicalIdSpanReplacement(targetId)
  const asRow = canonical === null
    ? null
    : parseExactReferenceBlockContent(FIELD_FORM_MARKER + canonical.text)
  if (canonical === null
    || asRow?.kind !== 'blockRef'
    || !asRow.fieldForm
    || asRow.id !== canonical.toTargetId) {
    console.warn(
      `[${context}] cannot re-key a marked row to canonical "::((${targetId}))" ` +
      `(target is not UUID-shaped, or the marked form no longer reads back as ` +
      `an id-addressed field row); leaving those rows unrewritten`,
    )
    return null
  }
  return canonical
}

/** Run the ladder. `null` means no rendering could carry this span —
 *  the caller must leave it alone rather than splice text that doesn't
 *  parse, which would destroy the link outright. Reported here so
 *  callers don't each restate it. */
export const preferredSpanReplacement = (
  request: SpanReplacementRequest,
): SpanReplacement | null => {
  const {wikilinkAlias, pinLabel, targetId, markedRow = false, context} = request
  if (wikilinkAlias !== null) {
    const wikilink = faithfulWikilinkReplacement(wikilinkAlias)
    if (wikilink !== null) return wikilink
  }
  if (markedRow) return markedRowReplacement(targetId, context)
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
