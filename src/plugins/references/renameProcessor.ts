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
import { aliasesProp } from '@/data/internals/coreProperties'
import {
  parseReferences,
  renderAliasedBlockref,
  renderWikilink,
  rewriteWikilinks,
} from './referenceParser.ts'

export const RENAME_BACKLINKS_PROCESSOR = 'references.renameBacklinks'

const SELECT_BACKLINK_SOURCES_SQL = `
  SELECT br.source_id AS sourceId, source.content AS sourceContent
  FROM block_references br
  JOIN blocks source ON source.id = br.source_id
  WHERE br.workspace_id = ?
    AND br.target_id = ?
    AND br.alias = ?
    AND source.deleted = 0
`

interface BacklinkSourceRow {
  sourceId: string
  sourceContent: string
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

/** Replacement form for a single removed alias α. Returns both the
 *  literal text spliced into source content AND the alias that should
 *  appear in the source's `references` entry for this target after
 *  the rewrite (so the inline references update mirrors what
 *  parseReferences would emit on a re-parse of the new content). */
export interface Replacement {
  /** Text spliced into source content in place of `[[α]]`. */
  text: string
  /** Alias the corresponding `BlockReference` carries after the
   *  rewrite. Wikilink form → the new alias `β`. Blockref form →
   *  the target id (parseReferences sets `alias === id` for blockref
   *  edges; see referencesProcessor.ts buildSourcePlan). */
  refAlias: string
}

export const replacementFor = (
  alias: string,
  removed: readonly string[],
  added: readonly string[],
  targetId: string,
): Replacement => {
  if (removed.length === 1 && added.length === 1) {
    // Only emit the wikilink form when it roundtrips through the
    // parser to the same alias. Two cases fail this:
    //   - Blank/whitespace alias → `renderWikilink('')` = `[[]]`, which
    //     parseReferences ignores (no link, dropped on the floor).
    //   - Alias containing `]]` → `renderWikilink` collapses it to
    //     `] ]`; the rendered form parses to a different alias than
    //     intended, silently corrupting the backlink text.
    // Fall through to the blockref form (which preserves the original
    // display text and pins to the target id) when the wikilink would
    // be lossy.
    const candidate = renderWikilink(added[0])
    if (parseReferences(candidate)[0]?.alias === added[0]) {
      return {text: candidate, refAlias: added[0]}
    }
  }
  // R4/R5/R6/R7/A2-cascade (and the wikilink-unsafe 1-for-1 fallback):
  // aliased blockref preserves the original display text the source
  // author wrote while pinning to the stable target id.
  return {text: renderAliasedBlockref(alias, targetId), refAlias: targetId}
}

/** One rewrite operation applied to a single source. `targetId` +
 *  `refAlias` drive the inline references update: each content ref
 *  matching `(targetId, alias, sourceField:'')` becomes
 *  `(targetId, refAlias, sourceField:'')`. Multiple rewrites per
 *  source accumulate when several aliases on the same target are
 *  removed in one commit. Order matters: applied in collection order. */
interface Rewrite {
  alias: string
  replacement: string
  targetId: string
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
    const replacement = replacementFor(alias, removed, added, after.id)
    const sources = await ctx.db.getAll<BacklinkSourceRow>(
      SELECT_BACKLINK_SOURCES_SQL,
      [after.workspaceId, after.id, alias],
    )
    for (const row of sources) {
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
        targetId: after.id,
        refAlias: replacement.refAlias,
      })
    }
  }
}

/** Apply rewrites to a source's `references` list. Swaps the alias on
 *  content edges matching `(targetId, oldAlias)` to the new ref alias.
 *  Property-typed refs (`sourceField !== ''`) are untouched — wikilink
 *  rewrites never affect them. Returned list is run through
 *  `normalizeReferences` so duplicates introduced by the swap (e.g.
 *  source already had `[[β]]` before we rewrote `[[α]] → [[β]]`)
 *  collapse, and the on-disk JSON stays canonical. */
const applyRefRewrites = (
  refs: ReadonlyArray<BlockReference>,
  rewrites: ReadonlyArray<Rewrite>,
): BlockReference[] => {
  if (rewrites.length === 0) return [...refs]
  // (targetId, oldAlias) → newRefAlias. Last-write-wins across rewrites
  // — mirrors the content rewrite order (each `rewriteWikilinks` pass
  // operates on the prior pass's output).
  const swaps = new Map<string, string>()
  const key = (targetId: string, alias: string) => `${targetId}\u0000${alias}`
  for (const rw of rewrites) swaps.set(key(rw.targetId, rw.alias), rw.refAlias)
  const next: BlockReference[] = []
  for (const ref of refs) {
    const sourceField = ref.sourceField ?? ''
    if (sourceField !== '') { next.push(ref); continue }
    const swapped = swaps.get(key(ref.id, ref.alias))
    next.push(swapped === undefined ? ref : {...ref, alias: swapped})
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
