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
 * blocks. parseReferences re-fires on the source-content edits and
 * refreshes the source's `references` column for free.
 *
 * Two-phase shape mirrors parseReferences: read phase outside any tx
 * builds a plan describing per-source rewrites AND records the source
 * content observed at decision time. Write phase opens one tx,
 * re-reads source content via `tx.get`, and skips the source entirely
 * if content has changed (later user edit wins — see `applyPlan`).
 * Otherwise applies the rewrites via parser-aware span splicing
 * (`rewriteWikilinks`).
 *
 * Idempotency: the rewrite produces source content that no longer
 * contains `[[α]]`, so a second pass over the same source content is
 * a no-op (no matching span). Rename doesn't re-fire on the source
 * content edit because its watcher is `properties`-only.
 */

import {
  ChangeScope,
  definePostCommitProcessor,
  type AnyPostCommitProcessor,
  type BlockData,
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

/** Replacement form for a single removed alias α. */
export const replacementFor = (
  alias: string,
  removed: readonly string[],
  added: readonly string[],
  targetId: string,
): string => {
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
    if (parseReferences(candidate)[0]?.alias === added[0]) return candidate
  }
  // R4/R5/R6/R7/A2-cascade (and the wikilink-unsafe 1-for-1 fallback):
  // aliased blockref preserves the original display text the source
  // author wrote while pinning to the stable target id.
  return renderAliasedBlockref(alias, targetId)
}

/** One rewrite operation applied to a single source. Multiple
 *  rewrites accumulate per source when several aliases on the same
 *  target are removed in one commit. Order matters: applied in the
 *  order collected. */
interface Rewrite {
  alias: string
  replacement: string
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
      plan.rewrites.push({alias, replacement})
    }
  }
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
  let next = current.content
  for (const rewrite of plan.rewrites) {
    next = rewriteWikilinks(next, rewrite.alias, rewrite.replacement)
  }
  if (next === current.content) return
  await tx.update(plan.sourceId, {content: next}, {skipMetadata: true})
}

/** True iff the alias-encoded value differs between before/after.
 *  Cheap pre-filter on the properties-field watcher so we skip the
 *  per-row decode + SQL when the change was a non-alias property. */
const aliasFieldChanged = (before: BlockData, after: BlockData): boolean => {
  const b = before.properties[aliasesProp.name]
  const a = after.properties[aliasesProp.name]
  return JSON.stringify(b ?? null) !== JSON.stringify(a ?? null)
}

export const renameBacklinksProcessor = definePostCommitProcessor({
  name: RENAME_BACKLINKS_PROCESSOR,
  // Properties-only: alias diffs ride this field. parseReferences
  // watches content separately and refreshes the references column on
  // the rewrites we issue, closing the loop.
  watches: { kind: 'field', table: 'blocks', fields: ['properties'] },
  apply: async (event: CommittedEvent<undefined>, ctx: ProcessorCtx) => {
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
  },
})

export const renamePostCommitProcessors: ReadonlyArray<AnyPostCommitProcessor> = [
  renameBacklinksProcessor,
]
