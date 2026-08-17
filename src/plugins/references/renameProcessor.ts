/**
 * Alias-rename backlink rewriter (spec: docs/alias-rename-cases.html
 * — rename ladder). SAME-TX processor.
 *
 * Watches alias-property diffs on `blocks`. For each removed alias α
 * with live backlinks (found via the `block_references` projection):
 *
 *   1. 1-for-1 swap (|removed| = |added| = 1) — R1, R2, A1-cascade,
 *      AR1-cascade: rewrite `[[α]] → [[new]]` in source content.
 *   2. Anything else with backlinks (R4, R5, R6, R7, A2-cascade):
 *      rewrite `[[α]] → [α](((target-id)))` (aliased blockref).
 *      Preserves the display text the source author wrote; doesn't
 *      depend on what's left in `aliases`.
 *   3. Pure add (no removed aliases) — R3: no-op.
 *
 * Lives next to `parseReferencesProcessor` in the references plugin
 * because it needs the `block_references` projection to find source
 * blocks.
 *
 * WHY SAME-TX (#461). This ran post-commit until then: a read phase
 * outside any transaction built a plan, then a second transaction
 * applied it. Everything hard about this processor lived in that gap.
 * A concurrent write could claim α, hand it off, mint an α-seat that a
 * re-derive then bound a span to, or edit the source — none of it
 * visible to the plan. Guarding it needed a process-wide rename queue,
 * a stale-content veto, an in-tx re-assert of the claimant check, and a
 * timestamp heuristic ("was this seat minted by MY window?") that no
 * available signal can actually answer: `skipMetadata` still ratchets
 * `updated_at`, so a re-derived span and a user-typed one are
 * indistinguishable. Six review rounds each found a new leak in that
 * heuristic. Running inside the user's transaction deletes the gap, and
 * with it all of that machinery — the claimant check becomes the plain
 * question "does anything still claim α?", asked once, atomically.
 *
 * Costs, accepted deliberately (Vlad, #461):
 *   - LATENCY. The cross-source rewrites are now on the user's commit
 *     path, one `tx.get` per source under the write lock, unbounded in
 *     the number of backlinks. Renames are rare and not on the typing
 *     path, so this is paid by a deliberate gesture rather than by
 *     keystrokes. The `sameTxProcessor.ts` header used to name this
 *     processor as the canonical thing same-tx is NOT for; that note is
 *     updated there.
 *   - BLAST RADIUS. A throw here rolls back the user's rename, where
 *     post-commit would have failed the rewrite alone and left the
 *     rename committed. That is the same trade `mergeRetargetProcessor`
 *     and `inlineDeletedBlockRefsProcessor` already make, and it is the
 *     right way round: a rename whose backlinks silently didn't follow
 *     is worse than a rename that visibly didn't happen.
 *
 * ORDERING — this processor must run AFTER `alias.sync`, and says so with
 * an explicit facet PRECEDENCE (`RENAME_BACKLINKS_PRECEDENCE`) rather than
 * by where it is registered. The primary rename gesture is editing a
 * page's TITLE, which writes `content`; the alias property is then amended
 * by `alias.sync` later in the same pass. Run before it and there is no
 * alias diff to react to at all — the rename silently never fires.
 *
 * Running in pass ONE (rather than reaching for `rerunOnDirtyRows`) is
 * also what keeps the kernel's derivation re-run downstream of our
 * writes: `core.projectPropertyChildren` re-projects the owner cell of
 * any property value child we rewrite. From pass two that re-run is
 * already behind us and the cell commits stale.
 *
 * Sync arrival has no counterpart, deliberately: same-tx processors are
 * bypassed for sync-applied rows, and a rename that arrives from another
 * device arrives with that device's backlink rewrites alongside it.
 *
 * Idempotency: the rewrite produces source content that no longer
 * contains `[[α]]`, so a second pass over the same source content is a
 * no-op (no matching span). Rename doesn't re-fire on the source content
 * edit because its watcher is `properties`-only.
 */

import {
  defineSameTxProcessor,
  normalizeReferences,
  type AnySameTxProcessor,
  type BlockData,
  type BlockReference,
  type SameTxCtx,
  type SameTxEvent,
  type Tx,
} from '@/data/api'
import { aliasesProp, getAliases } from '@/data/properties'
import { FIELD_FORM_MARKER, parseExactReferenceBlockContent } from '@/data/referenceBlock'
import { isPropertyFieldRow } from '@/data/propertyChildren'
import {
  deriveReferenceColumns,
  sameTxReferenceTargetLookups,
} from '@/data/internals/referenceTargetProcessor'
import {
  parseReferences,
  rewriteWikilinksMulti,
  type SpanReplacement,
} from './referenceParser.ts'
import {
  mergeReferrers,
  wikilinkSourcesByContent,
  type ReferrerRow,
} from './parseFence.ts'
import { preferredSpanReplacement } from './spanReplacement.ts'

export const RENAME_BACKLINKS_PROCESSOR = 'references.renameBacklinks'

/** Facet precedence for this processor's same-tx slot — see the ORDERING
 *  note above. `combineFacetContributions` sorts ascending by precedence
 *  (stable, so equal precedence keeps registration order), so any value
 *  above the default 0 puts this after every other same-tx processor
 *  registered today: the kernel trio, `core.normalizeReferences`,
 *  `core.migratePropertyRename`, the references plugin's own merge/inline
 *  processors, and — the one that matters — `alias.sync`.
 *
 *  Deliberately a precedence and not a registration position. Position
 *  would mean lifting this contribution out of `referencesDataExtension`
 *  so a composition root could place it after `aliasDataExtension` by
 *  hand, in every runtime that has both. That is the shape this shipped as
 *  first, and it is wrong for a reason unrelated to ordering: the
 *  extension is also the plugin's `systemToggle` boundary, so a bare
 *  contribution outside it keeps running when the user disables
 *  References — rewriting spans and invalidating edges with
 *  `parseReferences` gone and nothing left to rebuild them (Codex on
 *  PR #444). A precedence orders it without moving it.
 *
 *  Room deliberately left below: a processor that must run after
 *  `alias.sync` but BEFORE this one can take any value in 1..9. */
export const RENAME_BACKLINKS_PRECEDENCE = 10

/** Sources holding a CONTENT `[[alias]]` span bound to `targetId`.
 *
 *  Keyed on all three of `(workspace, alias, target)`. The alias alone is
 *  not enough — a span bound to some other block is not ours to rewrite —
 *  and the target alone is not enough, since one source can reference the
 *  renaming block under several names.
 *
 *  `source_field = ''` restricts to CONTENT edges. Property-derived edges
 *  carry `alias === targetId` so they could only collide with a
 *  UUID-shaped alias, and `applyRefRewrites` skips them anyway — but
 *  enumerating them still costs a `tx.get` per bogus source.
 *
 *  Read through `ctx.db` (the active transaction's read surface), so the
 *  trigger-maintained projection already reflects anything this tx has
 *  staged. Rides `idx_block_references_ws_alias` (`localSchema.ts`).
 *  Ordered for determinism, like the sibling same-tx processors. */
/** Edge-keyed leg of the enumeration. Complete only for rows whose
 *  post-commit parse has DRAINED — see `parseFence.ts` for the rows it
 *  misses and the content-keyed leg that covers them. */
const SELECT_BACKLINK_SOURCES_SQL = `
  SELECT DISTINCT br.source_id AS sourceId, source.content AS content
  FROM block_references br
  JOIN blocks source ON source.id = br.source_id
  WHERE br.workspace_id = ?
    AND br.alias = ?
    AND br.target_id = ?
    AND br.source_field = ''
    AND source.deleted = 0
  ORDER BY source.order_key, source.id
`

/** Is this source a MARKED NAME ROW for `alias` — a property field row
 *  whose whole content is `::[[alias]]`, addressing its definition by name
 *  rather than by id (§7/§9)? Selects the fallback tier: see
 *  `SpanReplacementRequest.markedRow`.
 *
 *  Asked of the CONTENT rather than of `is_field_form`, though the bit is
 *  derived from exactly this parse. The parse needs no stamp to have
 *  landed — this runs same-tx over rows the same commit may have just
 *  written, and slice 1 of #443 is the recorded cost of treating a derived
 *  column as the signal when the content is right there.
 *
 *  TWO parsers, each asked what it alone can answer. The whole-block parse
 *  establishes the SHAPE — `::` plus exactly one wikilink span, which is
 *  what makes the row a marked name row — and the inline parse supplies the
 *  ALIAS to compare, because that is the parser that produced the
 *  `block_references.alias` this enumeration is keyed on.
 *
 *  Content alone is NOT enough, and asking only it was a bug (Codex on
 *  PR #484). §9 recognition also needs a non-null parent — a workspace-root
 *  `::` row has no owner to be a field OF, so its marker is just text — a
 *  FLIPPED workspace, and a target that resolves to a definition.
 *  `isPropertyFieldRow` is that composed predicate, and it is awaited here
 *  rather than restated. Without it a root-level `::[[α]]`, or one pointing
 *  at an ordinary page, took the marked tier and lost the author's visible
 *  label to `::((id))` when it should keep the pinned form.
 *
 *  This is also why the tier is DORMANT today: every workspace is at
 *  `properties_migration = 'cell'`, so the flip probe refuses every row and
 *  the pinned tier handles all of them. That is correct, not a regression —
 *  a `::`-prefixed row in an unflipped workspace really is ordinary content.
 *
 *  Using `exact.alias` for the comparison was wrong, and not merely
 *  conservatively so (Codex on PR #484). The whole-block parser TRIMS its
 *  alias while the inline one does not, so a `::[[ α ]]` row whose alias is
 *  stored with padding — `tx.setProperty(aliasesProp, ['Old '])` is an
 *  existing, tested case — matched the edge but failed this equality, fell
 *  through to the pinned tier, and got `::[ α ](((id)))`: the invented
 *  label this whole arm exists to prevent, plus sanitization and its
 *  warning. Comparing the raw span makes the two agree by construction. */
const isMarkedNameRowFor = async (
  tx: Tx,
  source: BlockData,
  alias: string,
): Promise<boolean> => {
  const trimmed = source.content.trim()
  const exact = parseExactReferenceBlockContent(trimmed)
  if (exact?.kind !== 'alias' || !exact.fieldForm) return false
  const marks = parseReferences(trimmed)
  if (marks.length !== 1
    || marks[0].alias !== alias
    || marks[0].startIndex !== FIELD_FORM_MARKER.length
    || marks[0].endIndex !== trimmed.length) return false
  return isPropertyFieldRow(tx, source)
}

/** Replacement form for a single removed alias α — the rename ladder,
 *  composed from the shared `preferredSpanReplacement` policy.
 *
 *  `null` means "leave every span for this alias alone": no rendering
 *  could carry the reference, so any rewrite would destroy the link
 *  outright. Already reported by the time it returns.
 *
 *  R1/R2/A1-cascade: a clean 1-for-1 swap keeps the late-binding
 *  wikilink form. Everything else (R4/R5/R6/R7, A2-cascade) — and a
 *  1-for-1 whose new alias isn't wikilink-safe — pins to the target,
 *  labelled with the REMOVED alias so the source author's display text
 *  survives.
 *
 *  `markedRow` selects the fallback tier per SOURCE: a marked name row
 *  falls back to canonical `::((A))` instead of a pinned label (§11 group
 *  2 / #443 — see `SpanReplacementRequest.markedRow`). The wikilink tier
 *  is unaffected and still wins a clean 1-for-1, marked or not. */
export const replacementFor = (
  alias: string,
  removed: readonly string[],
  added: readonly string[],
  targetId: string,
  markedRow = false,
): SpanReplacement | null => preferredSpanReplacement({
  wikilinkAlias: removed.length === 1 && added.length === 1 ? added[0] : null,
  pinLabel: alias,
  targetId,
  markedRow,
  context: RENAME_BACKLINKS_PROCESSOR,
})

/** One rewrite operation applied to a single source. The target pair
 *  plus `refAlias` drive the inline references update: each content ref
 *  matching `(fromTargetId, alias, sourceField:'')` becomes
 *  `(toTargetId, refAlias, sourceField:'')`. Multiple rewrites per
 *  source accumulate when several aliases on the same target are
 *  removed in one commit. */
export interface Rewrite {
  alias: string
  replacement: string
  /** The edge's current target — the renaming block. Matching key for
   *  the entry swap, carried explicitly so `applyRefRewrites` needs no
   *  ambient knowledge of which block is being renamed. */
  fromTargetId: string
  /** Where the replacement text points — always the renaming block,
   *  and always its id EXACTLY. The wikilink branch stores `after.id`
   *  directly; the pinned branch stores what a re-parse of the spliced
   *  span yields, and `pinnedSpanReplacement` refuses any target whose
   *  id does not survive that round trip character-for-character. */
  toTargetId: string
  refAlias: string
  /** True when `replacement` is the PINNED form `[label](((id)))`.
   *  Drives the embed guard at the splice — see `rewriteWikilinks`. */
  pinned: boolean
}

/** Per-source plan: spans to rewrite, plus edges to invalidate. */
interface SourcePlan {
  sourceId: string
  rewrites: Rewrite[]
  /** Edges onto the renaming block that this pass decided NOT to
   *  rewrite and must therefore INVALIDATE. Dropping them is a
   *  `references` write, which is what schedules
   *  `references.parseReferences` to rebuild the binding from content. */
  staleEdges: Array<{alias: string; targetId: string}>
}

const planFor = (
  plansBySourceId: Map<string, SourcePlan>,
  sourceId: string,
): SourcePlan => {
  const existing = plansBySourceId.get(sourceId)
  if (existing !== undefined) return existing
  const created: SourcePlan = {sourceId, rewrites: [], staleEdges: []}
  plansBySourceId.set(sourceId, created)
  return created
}

/** Pull source plans for one target's alias diff and merge into the
 *  per-event `plansBySourceId` map. All reads go through the active tx,
 *  so they see this commit's staged state. */
const collectTargetPlans = async (
  ctx: SameTxCtx,
  before: BlockData,
  after: BlockData,
  plansBySourceId: Map<string, SourcePlan>,
  /** Aliases MORE THAN ONE target releases in this same commit — see
   *  `coReleasedAliases`. The content leg is skipped for these. */
  coReleased: ReadonlySet<string>,
): Promise<void> => {
  const beforeAliases = getAliases(before)
  const afterAliases = getAliases(after)
  const removed = beforeAliases.filter(a => !afterAliases.includes(a))
  if (removed.length === 0) return
  const added = afterAliases.filter(a => !beforeAliases.includes(a))

  for (const alias of removed) {
    const edgeSources = await ctx.db.getAll<ReferrerRow>(
      SELECT_BACKLINK_SOURCES_SQL,
      [after.workspaceId, alias, after.id],
    )
    // α's claimants (§11 group 2). This is the whole check — one read,
    // inside the tx that performed the release, so there is no window for a
    // competing claim to land in and no seat-exemption heuristic to get
    // wrong. A live claimant means α is not ours to re-key:
    //   - handoff — some other block owns the name now, so `[[α]]`
    //     already resolves where the author would expect. Rewriting it
    //     (to the new alias, or pinned to the block that just gave α up)
    //     would steal the span from its rightful target.
    //   - co-claim — the alias uniqueness trigger only fires for local
    //     user txs (`clientSchema.ts`), so sync-applied rows can leave
    //     several live blocks claiming one alias. Releasing one of them
    //     changes nothing about where `[[α]]` points (#460).
    // The renaming block itself can never appear here: `removed` is
    // computed from its own before/after, so by definition it no longer
    // claims α in this tx's staged state.
    //
    // Only a genuine RELEASE falls through to the rename ladder — and read
    // BEFORE the enumeration, because it also decides whether the fence
    // leg below is needed.
    const claimants = await ctx.tx.aliasClaimants(alias, after.workspaceId)
    // THE REFERENCES-PARSE FENCE. On a genuine release, add the rows whose
    // content carries `[[α]]` but whose edge hasn't been parsed yet —
    // `parseFence.ts` has the measurement and why the doc's "drain first"
    // is unavailable to a same-tx processor. Gated on the release path
    // because the content leg does no target check and is only SOUND there;
    // on a handoff it would merely be wasted work (see its docblock).
    // The content leg is sound only when THIS target owned every `[[α]]`
    // span — see `wikilinkSourcesByContent`. Two targets releasing α in one
    // commit both read zero claimants, so both would claim the same textual
    // referrers and the span would pin to whichever iterated last while its
    // edge followed the other. Fall back to the edge leg, which is
    // target-keyed and therefore still attributes each row correctly; the
    // undrained window simply stays open for that commit.
    const sources = claimants.length === 0 && !coReleased.has(alias)
      ? mergeReferrers(
          edgeSources,
          await wikilinkSourcesByContent(ctx.db, after.workspaceId, alias),
        )
      : edgeSources
    if (sources.length === 0) continue
    // Partitioned by fallback tier, then ONE ladder run per non-empty
    // partition. Not per source: `replacementFor` REPORTS on failure, and
    // running it per source would repeat the same warning once per
    // referrer. Not once overall either — the tier is a property of the
    // SOURCE (is this span the whole content of a marked name row?), not
    // of the alias.
    const partitions: Array<{markedRow: boolean; sourceIds: string[]}> = [
      {markedRow: false, sourceIds: []},
      {markedRow: true, sourceIds: []},
    ]
    for (const {sourceId} of sources) {
      // The row, not the enumerated content: recognition needs `parentId`,
      // `workspaceId` and the derived columns too, and `tx.get` sees this
      // tx's staged state.
      const source = await ctx.tx.get(sourceId)
      if (source === null) continue
      const marked = await isMarkedNameRowFor(ctx.tx, source, alias)
      partitions[marked ? 1 : 0].sourceIds.push(sourceId)
    }

    for (const {markedRow, sourceIds} of partitions) {
      if (sourceIds.length === 0) continue
      // `replacementFor` REPORTS when it returns null, so it is called only
      // on the release path — a handoff is not a rendering failure.
      const replacement = claimants.length === 0
        ? replacementFor(alias, removed, added, after.id, markedRow)
        : null
      for (const sourceId of sourceIds) {
        const plan = planFor(plansBySourceId, sourceId)
        if (replacement === null) {
          // Two ways to get here, one treatment. Either α was handed off /
          // co-claimed, or no rendering could carry the span (already
          // reported). Both leave the source's CONTENT alone — but the
          // stored edge still names the block that gave α up, and the
          // renderer resolves `[[α]]` through those stored edges
          // (`wikilinkMarkdownExtension` builds its alias→id map from
          // them), so leaving it would navigate the span to the wrong
          // block permanently. Dropping the edge is itself the write that
          // schedules `parseReferences` to rebind it, which resolves the
          // alias exactly as the renderer does — so computing the answer
          // here could only disagree with it.
          plan.staleEdges.push({alias, targetId: after.id})
          continue
        }
        plan.rewrites.push({
          alias,
          replacement: replacement.text,
          fromTargetId: after.id,
          toTargetId: replacement.toTargetId ?? after.id,
          refAlias: replacement.refAlias,
          pinned: replacement.toTargetId !== null,
        })
      }
    }
  }
}

/** Aliases that MORE THAN ONE target gives up in this one commit.
 *
 *  Normally impossible — the alias-uniqueness trigger admits a single
 *  claimant — but it fires only for local user transactions, so
 *  sync-applied rows can leave two blocks co-claiming one name (#460).
 *  When both then release it, each sees zero post-tx claimants and each
 *  would run the content leg over the SAME textual referrers, which is the
 *  one case that leg's "this target owned every span" premise does not
 *  cover (Codex on PR #484).
 *
 *  Computed once per event from the same before/after pairs the loop
 *  walks, so it costs nothing and cannot disagree with what the loop
 *  processes. */
const coReleasedAliases = (event: SameTxEvent): ReadonlySet<string> => {
  const releaseCount = new Map<string, number>()
  for (const row of event.changedRows) {
    if (row.before === null || row.after === null || row.after.deleted) continue
    if (!aliasFieldChanged(row.before, row.after)) continue
    const afterAliases = new Set(getAliases(row.after))
    for (const alias of new Set(getAliases(row.before))) {
      if (afterAliases.has(alias)) continue
      releaseCount.set(alias, (releaseCount.get(alias) ?? 0) + 1)
    }
  }
  return new Set([...releaseCount].filter(([, n]) => n > 1).map(([alias]) => alias))
}

/** Apply rewrites to a source's `references` list. Content edges
 *  matching `(fromTargetId, oldAlias)` are re-pointed at
 *  `(toTargetId, refAlias)`. Property-typed refs (`sourceField !== ''`)
 *  are untouched — wikilink rewrites never affect them. Returned list is
 *  run through `normalizeReferences` so duplicates introduced by the
 *  swap (e.g. source already had `[[β]]` before we rewrote
 *  `[[α]] → [[β]]`) collapse, and the on-disk JSON stays canonical.
 *
 *  Callers pass only the rewrites whose span actually went away — see
 *  `applyPlan`. An alias with a span still standing after its own
 *  rewrite is invalidated there instead, never swapped here. */
export const applyRefRewrites = (
  refs: ReadonlyArray<BlockReference>,
  rewrites: ReadonlyArray<Rewrite>,
): BlockReference[] => {
  if (rewrites.length === 0) return normalizeReferences([...refs])
  // (fromTargetId, oldAlias) → (toTargetId, newRefAlias). Last-write-
  // wins across rewrites, matching the content splice's own per-alias
  // last-wins map.
  const swaps = new Map<string, {id: string; alias: string}>()
  const key = (targetId: string, alias: string) => `${targetId}\u0000${alias}`
  for (const rw of rewrites) {
    swaps.set(key(rw.fromTargetId, rw.alias), {id: rw.toTargetId, alias: rw.refAlias})
  }
  const next: BlockReference[] = []
  for (const ref of refs) {
    if ((ref.sourceField ?? '') !== '') { next.push(ref); continue }
    const swapped = swaps.get(key(ref.id, ref.alias))
    next.push(swapped === undefined ? ref : {...ref, id: swapped.id, alias: swapped.alias})
  }
  return normalizeReferences(next)
}

/** Split a source's rewrites by whether their span actually WENT AWAY.
 *
 *  An alias whose span survives its own rewrite gets its edge invalidated,
 *  not swapped. The pinned form deliberately steps over `![[α]]` page
 *  embeds (splicing it under a leading `!` yields a markdown image — see
 *  `rewriteWikilinks`), so α can still have a live span afterwards, and in
 *  the extreme the source is embed-only and the content does not change at
 *  all. Swapping the entry there is wrong twice over: it announces a
 *  backlink for a span the content does not contain, and the surviving
 *  embed no longer belongs to the renaming block — α was released, so
 *  `![[α]]` late-binds elsewhere now. `normalizeReferences` collapses
 *  every occurrence of one alias into a SINGLE entry, so there is no way
 *  to say "the pinned span points here, the embed points there" in the
 *  stored list; only a re-parse can. Drop the entry and let it own the
 *  rebind (PR #444 round 7, P2).
 *
 *  Exported for a DIRECT unit test. Asserting it through the processor
 *  cannot work: the write is what schedules `parseReferences`, which
 *  re-derives the whole list from content and launders the phantom edge
 *  before any integration assertion can see it. The interval before that
 *  re-parse is the point — a backlink query or a second rename landing in
 *  it reads what this wrote. */
export const splitBySurvivingSpan = (
  rewrites: readonly Rewrite[],
  nextContent: string,
): {swapped: Rewrite[]; stranded: Rewrite[]} => {
  const remaining = new Set(parseReferences(nextContent).map(mark => mark.alias))
  return {
    swapped: rewrites.filter(rw => !remaining.has(rw.alias)),
    stranded: rewrites.filter(rw => remaining.has(rw.alias)),
  }
}

const applyPlan = async (tx: Tx, plan: SourcePlan): Promise<void> => {
  const current = await tx.get(plan.sourceId)
  if (current === null || current.deleted) return
  // ONE pass over the original spans, not one pass per alias. Sequential
  // passes re-parse the previous pass's output, so with `α → β` and
  // `β → γ` in a single commit an original `[[α]]` becomes `[[β]]` and is
  // then consumed again into `[[γ]]` — stealing α's link, while
  // `applyRefRewrites` still maps α's entry to β's block.
  // (`skipEmbeds` is per-alias: it tracks whether THAT replacement is the
  // pinned form. Last rewrite wins on a duplicate alias, matching the
  // entry swap's own last-write-wins map.)
  const nextContent = rewriteWikilinksMulti(
    current.content,
    new Map(plan.rewrites.map(rw => [rw.alias, {
      text: rw.replacement,
      skipEmbeds: rw.pinned,
      // Set only for the pinned form, and it is what lets the splice widen
      // over a `[display]([[α]])` wrapper instead of destroying it — see
      // `linkFormWrapperAround`.
      pinnedTargetId: rw.pinned ? rw.toTargetId : undefined,
    }])),
  )

  const {swapped, stranded} = splitBySurvivingSpan(plan.rewrites, nextContent)
  const invalidated = [
    ...plan.staleEdges,
    ...stranded.map(rw => ({alias: rw.alias, targetId: rw.fromTargetId})),
  ]

  // Surgically swap the matching `references` entries in lockstep with
  // the content rewrite so the `block_references` trigger refreshes the
  // projection inside this same SQL tx — and so the post-commit
  // `parseReferences` that fires on our content change re-derives the
  // same list and writes nothing (one undo entry for the whole rename,
  // not two).
  let nextRefs = applyRefRewrites(current.references, swapped)
  if (invalidated.length > 0) {
    // Content edges only (`sourceField === ''`): a property-derived entry
    // projects from its property value, which no rename touched.
    nextRefs = normalizeReferences(nextRefs.filter(ref =>
      (ref.sourceField ?? '') !== ''
      || !invalidated.some(s => s.alias === ref.alias && s.targetId === ref.id)))
  }

  const patch: Partial<Pick<
    BlockData, 'content' | 'references' | 'referenceTargetId' | 'isFieldForm'
  >> = {}
  if (nextContent !== current.content) {
    patch.content = nextContent
    // `core.deriveReferenceTarget` already ran earlier in this same tx
    // pass (kernel processors precede plugin ones) and stamped both local
    // columns from the PRE-rewrite content. A whole-block `[[α]]` row —
    // a property field row addressing its definition by name, or a value
    // child whose value IS a page reference — would otherwise keep
    // pointing at the target the removed alias resolved to. Recompute
    // from the rewritten content, the same contract `mergeRetargetProcessor`,
    // `inlineDeletedBlockRefsProcessor` and `alias.sync` follow. The
    // kernel's re-run pass would also catch this, but only for processors
    // downstream of it — and the column is what makes a row a field row,
    // so anything reading it in between must not see the stale value.
    const derived = await deriveReferenceColumns(
      nextContent, current.workspaceId, sameTxReferenceTargetLookups(tx),
    )
    // Always an update of an existing row (never a create), so an
    // unresolvable alias (`undefined`) clears the column rather than
    // preserving a caller-provided id the way the derive processor's
    // create path does.
    //
    // Gated on a content rewrite, and that is sufficient — checked, because
    // it looks like a hole (Codex on PR #444). The no-content-change paths
    // (handoff, co-claim, unrenderable replacement) still WRITE, because
    // they drop the stale edge; that write dirties the row, and the kernel's
    // derivation re-run visits dirty rows without filtering on watched
    // fields, re-deriving `[[α]]` against the tx's staged alias index. So
    // the stamp lands correct inside this same tx — pinned by "leaves an
    // exact-reference source correctly stamped after a handoff", which
    // asserts it at commit time rather than after the post-commit drain.
    //
    // What is genuinely NOT repaired is an exact-`[[α]]` row this pass never
    // touches — not a backlink source of the renaming block, so never
    // enumerated. Its stamp keeps naming the old claimant. That is the
    // kernel's own deliberately-deferred case, not ours:
    // `core.aliasClaimRederive` schedules a re-derive for alias GAINS only,
    // and its docblock states that re-pointing already-stamped rows (the
    // handoff/reclaim half) stays out until auto-claim lands.
    const nextTargetId = derived.targetId ?? null
    if ((current.referenceTargetId ?? null) !== nextTargetId) {
      patch.referenceTargetId = nextTargetId
    }
    if ((current.isFieldForm ?? false) !== derived.isFieldForm) {
      patch.isFieldForm = derived.isFieldForm
    }
  }
  if (JSON.stringify(nextRefs)
    !== JSON.stringify(normalizeReferences([...current.references]))) {
    patch.references = nextRefs
  }
  if (Object.keys(patch).length === 0) return
  // skipMetadata: rewriting someone else's backlink is bookkeeping
  // triggered by the target's rename, not a user edit of the source —
  // don't float it to the top of "recent".
  await tx.update(plan.sourceId, patch, {skipMetadata: true})
}

/** True iff the alias-encoded value differs between before/after.
 *  Cheap pre-filter on the properties-field watcher so we skip the
 *  per-row decode + SQL when the change was a non-alias property. */
const aliasFieldChanged = (before: BlockData, after: BlockData): boolean => {
  const b = before.properties[aliasesProp.name]
  const a = after.properties[aliasesProp.name]
  return JSON.stringify(b ?? null) !== JSON.stringify(a ?? null)
}

export const renameBacklinksProcessor = defineSameTxProcessor({
  name: RENAME_BACKLINKS_PROCESSOR,
  // Properties-only: alias diffs ride this field. The source content and
  // `references` we write are watched by the post-commit
  // `parseReferences`, which re-derives the same list and writes nothing.
  watches: {kind: 'field', table: 'blocks', fields: ['properties']},
  // Deliberately NOT `rerunOnDirtyRows` — see the ORDERING note in the
  // header. This processor is placed after `alias.sync` so the alias diff
  // is already settled when it fires in pass one, which keeps the
  // kernel's own re-run pass (project-property-children in particular)
  // downstream of the content we rewrite.
  //
  // The delete flow's release rewrite is deliberately NOT here. The doc's
  // sibling item — "the delete flow triggers the release rewrite
  // explicitly (a bare tombstone leaves no properties diff)" — needs the
  // definition-delete surface and a scope decision (§11 group 2 on #443,
  // overlapping #383). Watching `deleted` from this processor would
  // generalize the release rewrite to every page deletion, which is
  // exactly the call that issue defers (Vlad: don't change the current
  // rule beyond what props-as-blocks needs).
  apply: async (event: SameTxEvent, ctx: SameTxCtx) => {
    const plansBySourceId = new Map<string, SourcePlan>()
    const coReleased = coReleasedAliases(event)
    for (const row of event.changedRows) {
      if (row.before === null || row.after === null) continue
      if (row.after.deleted) continue
      if (!aliasFieldChanged(row.before, row.after)) continue
      await collectTargetPlans(ctx, row.before, row.after, plansBySourceId, coReleased)
    }
    // Collect every target's plans BEFORE applying any: one commit can
    // rename several targets that share a source, and the content splice
    // has to see all of that source's rewrites in one pass.
    for (const plan of plansBySourceId.values()) {
      await applyPlan(ctx.tx, plan)
    }
  },
})

export const renameSameTxProcessors: ReadonlyArray<AnySameTxProcessor> = [
  renameBacklinksProcessor,
]
