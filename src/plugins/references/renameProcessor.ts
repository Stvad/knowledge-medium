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
 * Two-phase shape mirrors parseReferences: read phase outside any tx;
 * write phase opens one tx for all source rewrites.
 *
 * Idempotency: the rewrite produces source content that no longer
 * contains `[[α]]`, so a second pass over the same source content is
 * a no-op (the regex doesn't match). Rename doesn't re-fire on the
 * source content edit because its watcher is `properties`-only.
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

export const RENAME_BACKLINKS_PROCESSOR = 'references.renameBacklinks'

const SELECT_BACKLINK_SOURCES_SQL = `
  SELECT br.source_id AS sourceId, source.content AS content
  FROM block_references br
  JOIN blocks source ON source.id = br.source_id
  WHERE br.workspace_id = ?
    AND br.target_id = ?
    AND br.alias = ?
    AND source.deleted = 0
`

interface BacklinkSourceRow {
  sourceId: string
  content: string
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

const REGEX_META = /[.*+?^${}()|[\]\\]/g
const escapeRegex = (s: string): string => s.replace(REGEX_META, '\\$&')

/** Replace every `[[alias]]` in `content` with `replacement`. Returns
 *  the new content; equality with `content` signals "no match", which
 *  the write phase uses to skip a no-op `tx.update`. */
export const rewriteWikilink = (
  content: string,
  alias: string,
  replacement: string,
): string => {
  const pattern = new RegExp(`\\[\\[${escapeRegex(alias)}\\]\\]`, 'g')
  return content.replace(pattern, replacement)
}

/** Replacement form for a single removed alias α. */
export const replacementFor = (
  alias: string,
  removed: readonly string[],
  added: readonly string[],
  targetId: string,
): string => {
  if (removed.length === 1 && added.length === 1) return `[[${added[0]}]]`
  // R4/R5/R6/R7/A2-cascade: aliased blockref preserves the original
  // display text the source author wrote while pinning to the stable
  // target id.
  return `[${alias}](((${targetId})))`
}

/** Per-source running plan. `nextContent` is the running rewrite; we
 *  layer additional alias-rewrites onto it as we encounter them. */
interface SourcePlan {
  sourceId: string
  originalContent: string
  nextContent: string
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
      const existing = plansBySourceId.get(row.sourceId)
      if (existing) {
        existing.nextContent = rewriteWikilink(existing.nextContent, alias, replacement)
      } else {
        plansBySourceId.set(row.sourceId, {
          sourceId: row.sourceId,
          originalContent: row.content,
          nextContent: rewriteWikilink(row.content, alias, replacement),
        })
      }
    }
  }
}

const applyPlan = async (tx: Tx, plan: SourcePlan): Promise<void> => {
  if (plan.nextContent === plan.originalContent) return
  await tx.update(plan.sourceId, {content: plan.nextContent}, {skipMetadata: true})
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
