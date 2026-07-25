/**
 * Alias-rename backlink rewriter (spec: docs/alias-rename-cases.html
 * — rename ladder).
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
 * Two-phase shape mirrors parseReferences: read phase outside any tx
 * builds a plan describing per-source rewrites AND records the source
 * content observed at decision time. Write phase opens one tx,
 * re-reads source content via `tx.get`, and skips the source entirely
 * if content has changed (later user edit wins — see `applyPlan`).
 * Otherwise applies the rewrites via parser-aware span splicing
 * (`rewriteWikilinks`) AND surgically swaps the matching `references`
 * entries in the same tx so the `block_references` trigger refreshes
 * in lockstep. Without that, a second rapid rename's SELECT would
 * race the separate parseReferences processor and miss the source —
 * leaving the backlink stuck on an alias the target no longer carries.
 *
 * Idempotency: the rewrite produces source content that no longer
 * contains `[[α]]`, so a second pass over the same source content is
 * a no-op (no matching span). Rename doesn't re-fire on the source
 * content edit because its watcher is `properties`-only.
 */

import {
  ChangeScope,
  definePostCommitProcessor,
  normalizeReferences,
  type AnyPostCommitProcessor,
  type BlockData,
  type BlockReference,
  type CommittedEvent,
  type ProcessorCtx,
  type Tx,
} from '@/data/api'
import { aliasesProp } from '@/data/properties'
import { isAliasSeatSlotId, matchesAliasSeatSeed } from '@/data/targets'
import {
  faithfulWikilinkReplacement,
  pinnedSpanReplacement,
  rewriteWikilinks,
  type SpanReplacement,
} from './referenceParser.ts'

export const RENAME_BACKLINKS_PROCESSOR = 'references.renameBacklinks'

/** Backlink sources for one removed alias — keyed on the ALIAS alone,
 *  with the target row joined so the caller can apply the
 *  claimant-or-provable-seat disjunction in JS (§11 group 2).
 *
 *  Keying on `(target_id, alias)` — as this did — silently skipped
 *  spans whose reference edge had already moved off the renaming
 *  claimant. That happens in the rename window: the rename case is
 *  necessarily outside the "rewrite content before alias surgery"
 *  ordering invariant (the rewrite CONSUMES the alias diff, and a
 *  synced-in rename arrives with the alias already moved), so a
 *  concurrent re-derive of `[[α]]` can bind the span to a freshly
 *  minted α-seat first. Such an edge matches the alias but not the
 *  target, and no later pass owns it — leaving a permanently
 *  seat-bound span. Enumerating by alias and filtering by target in
 *  JS lets those window-bound spans rewrite with the rest. */
const SELECT_BACKLINK_SOURCES_SQL = `
  SELECT br.source_id AS sourceId,
         source.content AS sourceContent,
         br.target_id AS targetId,
         target.content AS targetContent,
         target.properties_json AS targetProperties,
         EXISTS(
           SELECT 1 FROM blocks child
           WHERE child.parent_id = target.id AND child.deleted = 0
         ) AS targetHasLiveChildren
  FROM block_references br
  JOIN blocks source ON source.id = br.source_id
  JOIN blocks target ON target.id = br.target_id
  WHERE br.workspace_id = ?
    AND br.alias = ?
    AND source.deleted = 0
`

interface BacklinkSourceRow {
  sourceId: string
  sourceContent: string
  targetId: string
  targetContent: string
  targetProperties: string
  targetHasLiveChildren: 0 | 1
}

/** Live claimants of `alias`, with the same seat-shape columns as
 *  above, so a claim can be classified as a real block's or a
 *  throwaway machine seat's. */
const SELECT_ALIAS_CLAIMANTS_SQL = `
  SELECT b.id AS targetId,
         b.content AS targetContent,
         b.properties_json AS targetProperties,
         EXISTS(
           SELECT 1 FROM blocks child
           WHERE child.parent_id = b.id AND child.deleted = 0
         ) AS targetHasLiveChildren
  FROM block_aliases ba
  JOIN blocks b ON b.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND ba.alias = ?
    AND b.deleted = 0
`

/** The §7 seat-shape predicate evaluated on a joined `blocks` row: is
 *  this a machine-minted, never-touched seat for `alias`?
 *
 *  Three signals, none sufficient alone. The SHAPE (`aliasSeatSeed`)
 *  says nothing drifted — no rename, no user property, no extra alias
 *  — but quick-find's create-page writes exactly that shape too. The
 *  SLOT ID is what separates them: only `ensureAliasTarget` mints rows
 *  at `computeAliasSeatId(alias, ws, i)`, so a user's page carrying the
 *  same shape still has a random uuid. Live CHILDREN mean a user
 *  treated it as a real page regardless of the other two.
 *
 *  (Post-flip this needs to ignore the seat's own GENERATED property
 *  children rather than counting any live child — tracked as the seat
 *  predicate in #443 group 4, alongside `cleanupOrphanAliasesProcessor`.
 *  Today no seat has generated children, so the bare check matches
 *  `isRestorableTransientTombstone`'s.) */
const isMachineAliasSeat = (
  row: Pick<BacklinkSourceRow, 'targetId' | 'targetContent' | 'targetProperties' | 'targetHasLiveChildren'>,
  alias: string,
  workspaceId: string,
): boolean => {
  if (row.targetContent !== alias) return false
  if (row.targetHasLiveChildren === 1) return false
  if (!isAliasSeatSlotId(row.targetId, alias, workspaceId)) return false
  let properties: Record<string, unknown>
  try {
    properties = JSON.parse(row.targetProperties) as Record<string, unknown>
  } catch {
    return false
  }
  return matchesAliasSeatSeed({content: row.targetContent, properties})
}

const decodeAliases = (block: BlockData): readonly string[] => {
  const encoded = block.properties[aliasesProp.name]
  if (encoded === undefined) return []
  try {
    return aliasesProp.codec.decode(encoded)
  } catch {
    return []
  }
}

/** A verified replacement span: the literal text spliced into source
 *  content AND the alias the source's `references` entry must carry
 *  afterwards. Both halves come from the shared round-trip guard, so
 *  they can't drift apart. */
export type Replacement = SpanReplacement

/** Replacement form for a single removed alias α — the rename ladder,
 *  composed from the whole-span round-trip guard in
 *  `referenceParser.ts`.
 *
 *  `null` means "leave every span for this alias alone": no rendering
 *  could carry the reference, so any rewrite would destroy the link
 *  outright. Already reported by the time it returns. */
export const replacementFor = (
  alias: string,
  removed: readonly string[],
  added: readonly string[],
  targetId: string,
): Replacement | null => {
  if (removed.length === 1 && added.length === 1) {
    // R1/R2/A1-cascade: 1-for-1 swap keeps the late-binding wikilink
    // form — but only when it roundtrips to the same alias. Known
    // failures (blank alias, alias containing `]]`) fall through to
    // the pinned form rather than silently corrupting the backlink.
    const wikilink = faithfulWikilinkReplacement(added[0])
    if (wikilink !== null) return wikilink
  }
  // R4/R5/R6/R7/A2-cascade (and the wikilink-unsafe 1-for-1 fallback):
  // aliased blockref preserves the original display text the source
  // author wrote while pinning to the stable target id.
  const pinned = pinnedSpanReplacement(alias, targetId)
  if (pinned === null) {
    // The aliased form is UUID-only, so a non-UUID-shaped target can't
    // be pinned at all. Splicing the unparseable text would turn a
    // live backlink into prose; leaving `[[α]]` keeps the stored
    // reference entry (retained by the add-only contract) pointing at
    // the target, which is strictly the better of two bad states.
    console.warn(
      `[${RENAME_BACKLINKS_PROCESSOR}] target "${targetId}" cannot be pinned ` +
      `(not UUID-shaped); leaving [[${alias}]] spans unrewritten`,
    )
    return null
  }
  if (pinned.lossyLabel) {
    console.warn(
      `[${RENAME_BACKLINKS_PROCESSOR}] pinned span for alias "${alias}" displays ` +
      `sanitized text (\`]\`/newline stripped, whitespace trimmed); link preserved`,
    )
  }
  return pinned
}

/** One rewrite operation applied to a single source. The target pair
 *  plus `refAlias` drive the inline references update: each content ref
 *  matching `(fromTargetId, alias, sourceField:'')` becomes
 *  `(toTargetId, refAlias, sourceField:'')`. Multiple rewrites per
 *  source accumulate when several aliases on the same target are
 *  removed in one commit. Order matters: applied in collection order. */
export interface Rewrite {
  alias: string
  replacement: string
  /** The edge's CURRENT target — what the stored `references` entry
   *  says today. Usually the renaming block; a window-bound span
   *  carries the α-seat instead. Matching key for the entry swap. */
  fromTargetId: string
  /** Where the replacement text points — always the renaming block. */
  toTargetId: string
  refAlias: string
}

/** Per-source plan. Stores rewrites plus the source content observed
 *  during the read phase. Write phase re-reads the source via
 *  `tx.get`; if content has diverged at all, the rewrite is skipped
 *  entirely so the user's later edit wins strictly. Without this
 *  guard, a `[[α]]` the user typed in the race window between read
 *  and write would also be rewritten — they didn't exist at decision
 *  time and shouldn't be touched. */
interface SourcePlan {
  sourceId: string
  originalContent: string
  rewrites: Rewrite[]
}

/** Pull source plans for one target's alias diff and merge into the
 *  per-event `plansBySourceId` map. Reads via committed-state SQL —
 *  no tx open. */
const collectTargetPlans = async (
  ctx: ProcessorCtx,
  before: BlockData,
  after: BlockData,
  plansBySourceId: Map<string, SourcePlan>,
): Promise<void> => {
  const beforeAliases = decodeAliases(before)
  const afterAliases = decodeAliases(after)
  const removed = beforeAliases.filter(a => !afterAliases.includes(a))
  if (removed.length === 0) return
  const added = afterAliases.filter(a => !beforeAliases.includes(a))

  for (const alias of removed) {
    // Consult α's POST-TX claimant before deciding anything (§11
    // group 2). A live claimant means α is not ours to re-key:
    //   - handoff — some other block owns the name now, so `[[α]]`
    //     already resolves where the author would expect. Rewriting
    //     it (to the new alias, or pinned to the block that just gave
    //     α up) would steal the span from its rightful target.
    //   - re-claim — a later tx put α back on this same block, so the
    //     removal we're reacting to no longer holds.
    // Only a genuine RELEASE (nobody claims α) falls through to the
    // rename ladder. Machine seats are excluded from "claimant" on
    // purpose: a window-minted α-seat is the artifact this pass exists
    // to rewrite past, not a successor to defer to.
    const claimants = await ctx.db.getAll<
      Pick<BacklinkSourceRow, 'targetId' | 'targetContent' | 'targetProperties' | 'targetHasLiveChildren'>
    >(SELECT_ALIAS_CLAIMANTS_SQL, [after.workspaceId, alias])
    if (claimants.some(row => !isMachineAliasSeat(row, alias, after.workspaceId))) continue

    const replacement = replacementFor(alias, removed, added, after.id)
    // No rendering could carry this span — leave every source alone
    // (already reported by `replacementFor`).
    if (replacement === null) continue
    const sources = await ctx.db.getAll<BacklinkSourceRow>(
      SELECT_BACKLINK_SOURCES_SQL,
      [after.workspaceId, alias],
    )
    for (const row of sources) {
      // Target disjunction: the renaming claimant, or a
      // provably-untouched machine α-seat a window re-derive bound the
      // span to. Anything else is a different block that happens to
      // share the alias text — not ours.
      if (row.targetId !== after.id && !isMachineAliasSeat(row, alias, after.workspaceId)) continue
      // First sighting of this source pins `originalContent`. If a
      // later target rename hits the same source within this event,
      // both reads are inside the same committed snapshot so the
      // pinned value still matches what the second SELECT would see.
      let plan = plansBySourceId.get(row.sourceId)
      if (plan === undefined) {
        plan = {sourceId: row.sourceId, originalContent: row.sourceContent, rewrites: []}
        plansBySourceId.set(row.sourceId, plan)
      }
      plan.rewrites.push({
        alias,
        replacement: replacement.text,
        fromTargetId: row.targetId,
        toTargetId: after.id,
        refAlias: replacement.refAlias,
      })
    }
  }
}

/** Apply rewrites to a source's `references` list. Content edges
 *  matching `(fromTargetId, oldAlias)` are re-pointed at
 *  `(toTargetId, refAlias)`. BOTH halves move: a window-bound span's
 *  edge names the α-seat while the replacement text pins to the
 *  renaming block, so swapping only the alias would leave the entry
 *  naming a target the content no longer references.
 *  Property-typed refs (`sourceField !== ''`) are untouched — wikilink
 *  rewrites never affect them. Returned list is run through
 *  `normalizeReferences` so duplicates introduced by the swap (e.g.
 *  source already had `[[β]]` before we rewrote `[[α]] → [[β]]`)
 *  collapse, and the on-disk JSON stays canonical. */
export const applyRefRewrites = (
  refs: ReadonlyArray<BlockReference>,
  rewrites: ReadonlyArray<Rewrite>,
): BlockReference[] => {
  if (rewrites.length === 0) return [...refs]
  // (fromTargetId, oldAlias) → (toTargetId, newRefAlias). Last-write-
  // wins across rewrites — mirrors the content rewrite order (each
  // `rewriteWikilinks` pass operates on the prior pass's output).
  const swaps = new Map<string, {id: string; alias: string}>()
  const key = (targetId: string, alias: string) => `${targetId}\u0000${alias}`
  for (const rw of rewrites) {
    swaps.set(key(rw.fromTargetId, rw.alias), {id: rw.toTargetId, alias: rw.refAlias})
  }
  const next: BlockReference[] = []
  for (const ref of refs) {
    const sourceField = ref.sourceField ?? ''
    if (sourceField !== '') { next.push(ref); continue }
    const swapped = swaps.get(key(ref.id, ref.alias))
    next.push(swapped === undefined ? ref : {...ref, id: swapped.id, alias: swapped.alias})
  }
  return normalizeReferences(next)
}

const applyPlan = async (tx: Tx, plan: SourcePlan): Promise<void> => {
  // Strict "later user edit wins": if source content has changed
  // between our read phase and this write tx, skip entirely. Without
  // this we'd also rewrite `[[α]]` spans the user typed in the race
  // window — they didn't exist when we decided to rewrite, and the
  // user's typing should take precedence. The cost: a single
  // unrelated keystroke to the source between event and apply will
  // cancel this source's rewrite (acceptable — the next deliberate
  // rename of α catches it, or the user reconciles manually).
  const current = await tx.get(plan.sourceId)
  if (current === null || current.deleted) return
  if (current.content !== plan.originalContent) return
  let nextContent = current.content
  for (const rewrite of plan.rewrites) {
    nextContent = rewriteWikilinks(nextContent, rewrite.alias, rewrite.replacement)
  }
  if (nextContent === current.content) return
  // Surgically swap the matching `references` entries in lockstep with
  // the content rewrite so the `block_references` trigger refreshes
  // the projection inside this same SQL tx. parseReferences will fire
  // on the content change and re-emit the same list (idempotent), but
  // by then the next rename's SELECT already sees the up-to-date
  // index — no race window.
  const nextRefs = applyRefRewrites(current.references, plan.rewrites)
  await tx.update(
    plan.sourceId,
    {content: nextContent, references: nextRefs},
    {skipMetadata: true},
  )
}

/** True iff the alias-encoded value differs between before/after.
 *  Cheap pre-filter on the properties-field watcher so we skip the
 *  per-row decode + SQL when the change was a non-alias property. */
const aliasFieldChanged = (before: BlockData, after: BlockData): boolean => {
  const b = before.properties[aliasesProp.name]
  const a = after.properties[aliasesProp.name]
  return JSON.stringify(b ?? null) !== JSON.stringify(a ?? null)
}

/** Process-wide FIFO queue for rename invocations.
 *
 *  Rapid back-to-back title edits (e.g. cmd-Z + retype, or two
 *  setContent calls in quick succession) produce one rename event
 *  per user tx. Each event reads `block_references` to find sources,
 *  then opens a writeTransaction to rewrite. The READ phase runs
 *  outside the tx (cheap, doesn't hold a writer slot) — which means
 *  rename-N+1's SELECT can race ahead of rename-N's write commit,
 *  miss the source, and leave the backlink stuck on an alias the
 *  target no longer carries.
 *
 *  SQLite serializes writeTransactions, so rename-N+1's tx waits for
 *  rename-N's tx to commit — but by then rename-N+1 has already
 *  taken its (stale) read snapshot. The serializer-at-write boundary
 *  is too late; we have to serialize the whole read-plan-write
 *  cycle. Module-level FIFO queue does that with one promise chain.
 *
 *  Cost: at most one rename runs at a time process-wide. Acceptable
 *  because rename is post-commit and not on the typing path; the
 *  alternative (in-tx SELECT, or per-source mutex keyed on resolved
 *  source ids that we don't know pre-read) is more complex for the
 *  same end-state.
 *
 *  Errors swallowed at the chain level (re-thrown to the original
 *  caller) so a single rename failure doesn't block subsequent
 *  renames. */
let renameQueue: Promise<void> = Promise.resolve()
const serializeRename = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = renameQueue.then(fn)
  // Continue the chain regardless of this fn's outcome — failures
  // are surfaced to the caller via the returned promise (which we
  // don't intercept), not the chain anchor.
  renameQueue = next.then(() => {}, () => {})
  return next
}

export const renameBacklinksProcessor = definePostCommitProcessor({
  name: RENAME_BACKLINKS_PROCESSOR,
  // Properties-only: alias diffs ride this field. parseReferences
  // watches content separately and refreshes the references column on
  // the rewrites we issue, closing the loop.
  watches: { kind: 'field', table: 'blocks', fields: ['properties'] },
  apply: async (event: CommittedEvent<undefined>, ctx: ProcessorCtx) =>
    serializeRename(async () => {
      const plansBySourceId = new Map<string, SourcePlan>()
      for (const row of event.changedRows) {
        if (row.before === null || row.after === null) continue
        if (row.after.deleted) continue
        if (!aliasFieldChanged(row.before, row.after)) continue
        await collectTargetPlans(ctx, row.before, row.after, plansBySourceId)
      }
      if (plansBySourceId.size === 0) return

      await ctx.repo.tx(async tx => {
        for (const plan of plansBySourceId.values()) await applyPlan(tx, plan)
      }, {
        scope: ChangeScope.References,
        description: `processor: ${RENAME_BACKLINKS_PROCESSOR}`,
      })
    }),
})

export const renamePostCommitProcessors: ReadonlyArray<AnyPostCommitProcessor> = [
  renameBacklinksProcessor,
]
