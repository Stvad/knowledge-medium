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
 * builds a plan describing per-source rewrites; write phase opens
 * one tx, re-reads source content via `tx.get` (so user edits made
 * after the read phase aren't clobbered), and applies the rewrites
 * via parser-aware span splicing — the same wikilinks are found in
 * the current text, rewritten in place, and skipped when they no
 * longer exist (e.g. the user deleted the wikilink concurrently).
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
  renderAliasedBlockref,
  renderWikilink,
  rewriteWikilinks,
} from '@/utils/referenceParser'

export const RENAME_BACKLINKS_PROCESSOR = 'references.renameBacklinks'

const SELECT_BACKLINK_SOURCES_SQL = `
  SELECT br.source_id AS sourceId
  FROM block_references br
  JOIN blocks source ON source.id = br.source_id
  WHERE br.workspace_id = ?
    AND br.target_id = ?
    AND br.alias = ?
    AND source.deleted = 0
`

interface BacklinkSourceIdRow {
  sourceId: string
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
  if (removed.length === 1 && added.length === 1) return renderWikilink(added[0])
  // R4/R5/R6/R7/A2-cascade: aliased blockref preserves the original
  // display text the source author wrote while pinning to the stable
  // target id.
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

/** Per-source plan. Stores rewrites rather than a pre-baked
 *  `nextContent` so the write phase re-reads the current source
 *  content via `tx.get` and applies the rewrites against fresh
 *  state — avoids clobbering edits the user made between the read
 *  and write phases. */
interface SourcePlan {
  sourceId: string
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
    const sources = await ctx.db.getAll<BacklinkSourceIdRow>(
      SELECT_BACKLINK_SOURCES_SQL,
      [after.workspaceId, after.id, alias],
    )
    for (const row of sources) {
      const plan = plansBySourceId.get(row.sourceId) ?? {
        sourceId: row.sourceId,
        rewrites: [],
      }
      plan.rewrites.push({alias, replacement})
      plansBySourceId.set(row.sourceId, plan)
    }
  }
}

const applyPlan = async (tx: Tx, plan: SourcePlan): Promise<void> => {
  // Re-read inside the write tx so concurrent edits to the source
  // (made after our committed-state read but before this write)
  // aren't clobbered by a stale `nextContent`. The rewrites operate
  // on parser spans — if the user deleted the wikilink in between,
  // there's nothing to match and the rewrite is a no-op.
  const current = await tx.get(plan.sourceId)
  if (current === null || current.deleted) return
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
