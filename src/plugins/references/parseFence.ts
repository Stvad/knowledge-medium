/**
 * The REFERENCES-PARSE FENCE (properties-as-blocks §9/§11 group 4).
 *
 * `block_references` is a trigger-maintained projection of
 * `blocks.references_json`, and that column is written by
 * `references.parseReferences` — a POST-COMMIT processor. So a row whose
 * content was written in a PREVIOUS transaction can have no edge at all:
 * its parse is scheduled and hasn't drained. Any enumeration that reads
 * only the edge table silently misses it.
 *
 * Measured, on the alias-release path: a source created with content
 * `see [[Old]]` and a rename of `Old → New` landing before the parse
 * drained left the source at `see [[Old]]`, and the late parse then
 * MINTED A SEAT for the now-unclaimed `Old` and bound the span to that
 * empty stub. The user's link to a real block became a link to nothing,
 * with no error anywhere.
 *
 * The doc's fix — "both flows are prompted one-shots, so they drain
 * pending reference parsing for the workspace before enumerating" — is
 * not available to a SAME-TX processor: rename now runs inside the user's
 * `writeTransaction` and cannot await transactions that have yet to open.
 * (Nor is `awaitIdle()` a complete drain anyway: `processorRunner`'s
 * `pending` set does not include a delayed job whose timer hasn't fired,
 * so there is no reliable "is a parse outstanding?" signal to gate on
 * either.)
 *
 * What IS available is a second index over the same text that does not
 * lag: `blocks_fts`, the trigram FTS5 index over `blocks.content`. Like
 * `block_aliases`, it is maintained by TRIGGERS — so it is written in the
 * same SQL transaction as the content itself and is current the instant a
 * write commits, no processor involved. Reading it through the active
 * tx's `ctx.db` therefore sees every committed row plus this tx's own
 * staged writes. That is the fence: ask the index that can't be stale.
 *
 * The FTS index is `case_sensitive 0` and trigram-based, so a MATCH is a
 * CANDIDATE filter — it returns `[[old]]` for alias `Old`. Candidates are
 * re-parsed and kept only if they carry a span whose alias matches
 * character-for-character, the same comparison `block_references.alias`
 * uses. That filter is an EFFICIENCY guard, not a correctness one, and it
 * is labelled so because mutation-testing says so: dropping it fails
 * nothing. A wrong-case row that slips through is keyed on an alias its
 * content doesn't contain, so `rewriteWikilinksMulti` splices nothing and
 * `applyRefRewrites` finds no entry to swap — it costs a wasted plan, not
 * a wrong write. Keeping it means the candidate set that reaches the
 * per-source classification is the real referrer set.
 */

import type { SameTxReadDb } from '@/data/api'
import { parseReferences } from './referenceParser.ts'

/** One enumerated referrer: the id plus the content every caller needs
 *  anyway (to classify the row and to splice its spans). */
export interface ReferrerRow {
  sourceId: string
  content: string
}

/** Candidate rows whose CONTENT contains a literal substring, read from
 *  the trigger-maintained trigram index.
 *
 *  `b.content != ''` mirrors the `blocks_fts` triggers, which skip
 *  empty-content rows — stated here so the join can't silently return a
 *  row the index doesn't actually cover. Ordered like the edge-keyed
 *  enumerations it supplements, so a merged result stays deterministic. */
const SELECT_FTS_CANDIDATES_SQL = `
  SELECT blocks_fts.block_id AS sourceId, b.content AS content
  FROM blocks_fts
  JOIN blocks b
    ON b.id = blocks_fts.block_id
   AND b.workspace_id = blocks_fts.workspace_id
  WHERE blocks_fts.workspace_id = ?
    AND blocks_fts MATCH ?
    AND b.deleted = 0
    AND b.content != ''
  ORDER BY b.order_key, b.id
`

/** An FTS5 phrase matching `text` literally. Double-quoting makes every
 *  character inside it user text rather than FTS5 syntax — which the
 *  wikilink form needs, since `[`, `]` and `*` are all operators
 *  otherwise — and `""` is FTS5's own escape for an embedded quote.
 *
 *  Trigram tokenizers need at least 3 characters to match, and the
 *  shortest wikilink form is `[[a]]` at five, so no alias is too short to
 *  be searchable. */
const ftsPhrase = (text: string): string => `"${text.replace(/"/g, '""')}"`

/**
 * Sources carrying a `[[alias]]` span in their CONTENT right now,
 * regardless of whether their edge has been parsed yet.
 *
 * The complement to an edge-keyed enumeration, not a replacement for it:
 * an edge can also outlive its span (content edited to drop the span,
 * parse not yet drained), and only the edge table knows about that. Merge
 * the two.
 *
 * NO target check, deliberately, and it needs none where callers use
 * this: on the RELEASE path the renaming block was the alias's only
 * claimant (a surviving claimant would have made it a handoff), so every
 * `[[alias]]` span in the workspace resolved to it. That is why callers
 * must gate this on the release path — the result is only sound there.
 *
 * Calling it on a handoff/co-claim path is WASTEFUL rather than wrong,
 * which mutation-testing confirms: doing so fails no test. There the
 * rewrite changes no content and only drops stale edges, and a row with no
 * edge yet has none to drop, so the extra rows plan a no-op. The gate
 * keeps an FTS scan off a path that provably cannot use its result.
 */
export const wikilinkSourcesByContent = async (
  db: SameTxReadDb,
  workspaceId: string,
  alias: string,
): Promise<ReferrerRow[]> => {
  if (alias === '') return []
  const candidates = await db.getAll<ReferrerRow>(
    SELECT_FTS_CANDIDATES_SQL,
    [workspaceId, ftsPhrase(`[[${alias}]]`)],
  )
  return candidates.filter(row =>
    parseReferences(row.content).some(mark => mark.alias === alias))
}

/** Union the legs, first occurrence of an id winning.
 *
 *  CONCATENATION, not a k-way merge: each group arrives in its own
 *  `(order_key, id)` order and those orders are preserved WITHIN a group,
 *  but the result is group-by-group, so a content-leg row with a lower
 *  `order_key` still lands after every edge-leg row. Deterministic — same
 *  inputs, same output — which is all the callers need, and stated
 *  precisely because the earlier wording claimed a global sort this does
 *  not provide (Codex on PR #484). Nothing downstream may rely on
 *  cross-leg order: each source is planned independently, and both the
 *  splice and the entry swap are keyed by alias through a Map. Carrying
 *  `order_key` through just to sort would buy no observable behaviour.
 *
 *  A union, so the content leg's own WHERE-clause exclusions (`blocks_fts`
 *  skips empty-content rows) can never drop a row the edge leg found. */
export const mergeReferrers = (
  ...groups: ReadonlyArray<readonly ReferrerRow[]>
): ReferrerRow[] => {
  const byId = new Map<string, ReferrerRow>()
  for (const group of groups) {
    for (const row of group) if (!byId.has(row.sourceId)) byId.set(row.sourceId, row)
  }
  return [...byId.values()]
}
