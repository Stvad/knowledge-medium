/**
 * Reference parsing + orphan-alias cleanup post-commit processors (spec §7).
 *
 * `references.parseReferences`
 *   - watches: { kind: 'field', table: 'blocks', fields: ['content', 'properties'] }
 *   - For each changedRow whose `content` or `properties` changed (insert
 *     or update), parse `[[alias]]` / `((uuid))` references and ref-typed
 *     properties.
 *   - Resolve aliases to existing target ids via a workspace-scoped
 *     SQL lookup (committed-state read via ctx.db). On miss, create
 *     the target via ensureAliasTarget / ensureDailyNoteTarget.
 *   - Write `tx.update(sourceId, {references}, {skipMetadata: true})`.
 *   - If any non-date alias target was newly inserted (or restored),
 *     schedule `references.cleanupOrphanAliases` with
 *     `{newlyInsertedAliasTargetIds}` after delayMs: 4000.
 *   - Opens its own tx via `ctx.repo.tx(..., {scope:
 *     ChangeScope.References})` — separate undo bucket; uploads.
 *
 * `references.cleanupOrphanAliases`
 *   - watches: { kind: 'explicit' }
 *   - scheduledArgsSchema: z.object({newlyInsertedAliasTargetIds: z.array(z.string())})
 *     (validated at enqueue time so a bad arg fails the originating tx)
 *   - For each candidate id: if no block currently references it,
 *     `tx.delete(id)` (subtree-aware soft-delete via the kernel
 *     mutator path? — for v1 just tx.delete since target blocks are
 *     leaves).
 *   - Date-shaped alias targets are excluded from the cleanup list at
 *     parseReferences-schedule time (§7.6 daily-note exemption); this
 *     processor only sees non-date ids.
 *
 * Why not in-tx parseReferences (§7.1): same-tx parsing would add
 * typing latency to a hot path. Today's app already runs follow-up
 * parsing fire-and-forget; the redesign keeps that shape.
 *
 * Two-phase shape (v4.32, see §5.7): both processors do their reads
 * BEFORE opening a write tx. The framework no longer auto-wraps apply
 * in a writeTransaction, so the read phase doesn't hold a writer slot
 * and reads can't queue behind a writer-that-awaits-them (the
 * `tasks/processor-tx-deadlock.md` shape). The write phase still uses a
 * single tx for atomicity (target writes + references update +
 * afterCommit schedule all commit together).
 */

import { z } from 'zod'
import {
  ChangeScope,
  definePostCommitProcessor,
  normalizeReferences,
  type BlockData,
  type BlockReference,
  type AnyPostCommitProcessor,
  type CommittedEvent,
  type ProcessorCtx,
  type TypeRegistrySnapshot,
  type Tx,
} from '@/data/api'
import {
  parseReferences as parseAliasMarks,
  parseBlockRefs,
} from './referenceParser.ts'
import { projectPropertyReferences } from './referenceProjection.ts'
import { aliasSeatReaderFromDb, ensureAliasTarget, resolveAliasSeatId } from '@/data/targets'
import {
  dailyNoteBlockId,
  ensureDailyNoteTarget,
} from '@/plugins/daily-notes/dailyNotes.js'
import { parseLiteralDailyPageTitle } from '@/utils/relativeDate.js'

export const PARSE_REFERENCES_PROCESSOR = 'references.parseReferences'
export const CLEANUP_ORPHAN_ALIASES_PROCESSOR = 'references.cleanupOrphanAliases'

const SELECT_LIVE_REFERENCE_SOURCE_SQL = `
  SELECT 1 AS present
  FROM block_references br
  JOIN blocks source ON source.id = br.source_id
  WHERE br.workspace_id = ?
    AND br.target_id = ?
    AND source.deleted = 0
  LIMIT 1
`

/** Per-source plan built during the read phase. The write phase consumes
 *  this and issues all writes in a single tx. */
interface SourcePlan {
  sourceId: string
  workspaceId: string
  /** Resolved-or-to-be-created refs the source's `references` column
   *  should end up with. The id may name a non-yet-existing target if
   *  the write phase will create it (alias case below). */
  references: BlockReference[]
  /** Aliases to be created via `ensureAliasTarget` in the write phase.
   *  Excludes ids resolved by lookup (those already exist). */
  aliasesToEnsure: string[]
  /** ISO dates to be created via `ensureDailyNoteTarget` in the write phase. */
  datesToEnsure: string[]
  /** True iff the planned `references` differ from what's currently on
   *  the row — used to skip a no-op write that would re-fire the
   *  field-watcher and produce a useless row_events / ps_crud entry. */
  referencesChanged: boolean
}

/** Read phase: parse refs, resolve existing alias targets via committed-
 *  state lookup, and produce a SourcePlan describing what the write
 *  phase needs to do. No tx opened here — `ctx.repo.query.aliasLookup`
 *  hits committed state. */
const buildSourcePlan = async (
  ctx: ProcessorCtx,
  source: BlockData,
): Promise<SourcePlan> => {
  const aliasMarks = parseAliasMarks(source.content)
  const blockRefMarks = parseBlockRefs(source.content)

  const aliasRefs: BlockReference[] = []
  const dateRefs: BlockReference[] = []
  const aliasesToEnsure: string[] = []
  const datesToEnsure: string[] = []
  const seenAliases = new Set<string>()

  for (const mark of aliasMarks) {
    if (seenAliases.has(mark.alias)) continue
    seenAliases.add(mark.alias)
    const dailyTitle = parseLiteralDailyPageTitle(mark.alias)
    if (dailyTitle !== null) {
      // Daily note path — distinct deterministic id, never feeds cleanup.
      // Store the user's literal alias on the source reference, but
      // materialise the canonical ISO daily-note target. `parseLiteral...`
      // accepts ISO and Roam long-form titles while rejecting relative
      // words like "today", "friday", and "may" so those remain aliases.
      const id = dailyNoteBlockId(source.workspaceId, dailyTitle.iso)
      dateRefs.push({id, alias: mark.alias})
      datesToEnsure.push(dailyTitle.iso)
      continue
    }
    // Non-date alias — try lookup-first to skip the deterministic-id
    // codec round-trip when an existing target already carries the
    // alias (e.g. typing `[[Inbox]]` for an Inbox someone else made
    // via the create-page UI; §7.5 race).
    const existing = await ctx.repo.query
      .aliasLookup({workspaceId: source.workspaceId, alias: mark.alias})
      .load()
    if (existing !== null) {
      aliasRefs.push({id: existing.id, alias: mark.alias})
      continue
    }
    // Will be created by ensureAliasTarget in the write phase. The
    // id is the result of the indexed-deterministic seat probe — slot
    // 0 unless a prior alias claims it (post-rename collision) or it's
    // tombstoned. We probe here (read-phase, committed state) so the
    // predicted id matches what ensureAliasTarget will pick in the
    // write phase. Convergence: same world-state → same probe answer.
    const id = await resolveAliasSeatId(
      aliasSeatReaderFromDb(ctx.db),
      mark.alias,
      source.workspaceId,
    )
    aliasRefs.push({id, alias: mark.alias})
    aliasesToEnsure.push(mark.alias)
  }

  const blockRefs: BlockReference[] = []
  const seenBlockRefs = new Set<string>()
  for (const mark of blockRefMarks) {
    if (seenBlockRefs.has(mark.blockId)) continue
    seenBlockRefs.add(mark.blockId)
    blockRefs.push({id: mark.blockId, alias: mark.blockId})
  }

  const propertyRefs = projectPropertyReferences(source, ctx.propertySchemas)
  const references: BlockReference[] = [...aliasRefs, ...dateRefs, ...blockRefs, ...propertyRefs]
  // tx.update normalises references on write, so `source.references`'s
  // JSON text — when written by any tx.* path — is already in canonical
  // form (sorted, deduped, omitted-empty-sourceField, no whitespace).
  // Re-stringifying through V8's key-order-preserving JSON.parse →
  // JSON.stringify reproduces the same text, so equality compares
  // canonical to canonical without a second normalize on this side.
  // Rows that bypassed normalize-on-write (legacy data, raw bypass
  // writes) will fail this equality and get rewritten on first parse —
  // exactly the convergence we want.
  const referencesChanged =
    JSON.stringify(source.references)
    !== JSON.stringify(normalizeReferences(references))

  return {
    sourceId: source.id,
    workspaceId: source.workspaceId,
    references,
    aliasesToEnsure,
    datesToEnsure,
    referencesChanged,
  }
}

/** Write phase: apply one source's plan inside the active tx. Returns
 *  the list of alias-target ids this tx actually inserted (for
 *  cleanup-eligibility filtering — only `ensureAliasTarget`'s
 *  `inserted: true` results count; date results never feed cleanup per
 *  §7.6). */
const applySourcePlan = async (
  tx: Tx,
  ctx: ProcessorCtx,
  plan: SourcePlan,
  typeSnapshot: TypeRegistrySnapshot,
): Promise<string[]> => {
  const newlyInserted: string[] = []
  for (const date of plan.datesToEnsure) {
    await ensureDailyNoteTarget(tx, ctx.repo, date, plan.workspaceId, typeSnapshot)
  }
  for (const alias of plan.aliasesToEnsure) {
    const ensured = await ensureAliasTarget(tx, ctx.repo, alias, plan.workspaceId, typeSnapshot)
    if (ensured.inserted) newlyInserted.push(ensured.id)
  }
  if (plan.referencesChanged) {
    await tx.update(plan.sourceId, {references: plan.references}, {skipMetadata: true})
  }
  return newlyInserted
}

/** True iff this plan needs any write — either a target ensure call
 *  (insert/restore) or a references-column update. Used to skip opening
 *  a tx entirely when the parse came out idempotent. */
const planNeedsWrite = (plan: SourcePlan): boolean =>
  plan.referencesChanged
  || plan.aliasesToEnsure.length > 0
  || plan.datesToEnsure.length > 0

export const parseReferencesProcessor = definePostCommitProcessor({
  name: PARSE_REFERENCES_PROCESSOR,
  watches: { kind: 'field', table: 'blocks', fields: ['content', 'properties'] },
  apply: async (event: CommittedEvent<undefined>, ctx: ProcessorCtx) => {
    // Read phase — outside any tx; bare-connection reads, no writer
    // contention. Each plan describes what the write phase needs to do
    // (or nothing, if the parse came out idempotent).
    const plans: SourcePlan[] = []
    for (const row of event.changedRows) {
      // Skip hard-deletes (after === null) — nothing to parse.
      if (row.after === null) continue
      // Skip soft-deletes (after.deleted === true) — same reason.
      if (row.after.deleted) continue
      plans.push(await buildSourcePlan(ctx, row.after))
    }
    if (!plans.some(planNeedsWrite)) return

    // Write phase — single tx, atomic for refs + targets + afterCommit.
    const typeSnapshot = ctx.repo.snapshotTypeRegistries()
    await ctx.repo.tx(async tx => {
      const allNewlyInserted: string[] = []
      let workspaceForCleanup: string | null = null
      for (const plan of plans) {
        if (!planNeedsWrite(plan)) continue
        const inserted = await applySourcePlan(tx, ctx, plan, typeSnapshot)
        allNewlyInserted.push(...inserted)
        // All sources in one tx share a workspace per spec invariant 11
        // — pin the first non-null and use it for cleanup scheduling.
        workspaceForCleanup ??= plan.workspaceId
      }
      if (allNewlyInserted.length > 0 && workspaceForCleanup !== null) {
        tx.afterCommit(
          CLEANUP_ORPHAN_ALIASES_PROCESSOR,
          {
            workspaceId: workspaceForCleanup,
            newlyInsertedAliasTargetIds: allNewlyInserted,
          },
          { delayMs: 4000 },
        )
      }
    }, {
      scope: ChangeScope.References,
      description: `processor: ${PARSE_REFERENCES_PROCESSOR}`,
    })
  },
})

// ──── references.cleanupOrphanAliases ────

const cleanupArgsSchema = z.object({
  workspaceId: z.string(),
  newlyInsertedAliasTargetIds: z.array(z.string()),
})

interface CleanupArgs {
  workspaceId: string
  newlyInsertedAliasTargetIds: string[]
}

declare module '@/data/api' {
  interface PostCommitProcessorRegistry {
    [CLEANUP_ORPHAN_ALIASES_PROCESSOR]: CleanupArgs
  }
}

export const cleanupOrphanAliasesProcessor = definePostCommitProcessor<CleanupArgs>({
  name: CLEANUP_ORPHAN_ALIASES_PROCESSOR,
  watches: { kind: 'explicit' },
  scheduledArgsSchema: cleanupArgsSchema,
  apply: async (event: CommittedEvent<CleanupArgs>, ctx: ProcessorCtx) => {
    const ids = event.scheduledArgs?.newlyInsertedAliasTargetIds ?? []
    const workspaceId = event.scheduledArgs?.workspaceId ?? ''
    if (ids.length === 0 || !workspaceId) return

    // Read phase — gather actual orphans without holding a writer slot.
    const orphans: string[] = []
    for (const id of ids) {
      const source = await ctx.db.getOptional<{present: number}>(
        SELECT_LIVE_REFERENCE_SOURCE_SQL,
        [workspaceId, id],
      )
      if (source === null) orphans.push(id)
    }
    if (orphans.length === 0) return

    // Write phase — soft-delete the orphans. Single tx so the deletes
    // are atomic and produce one command_events row.
    await ctx.repo.tx(async tx => {
      for (const id of orphans) {
        // No block references it — orphan. Soft-delete (the §7 cleanup
        // is leaf-only by construction; the alias target was created
        // empty so it has no children to cascade). tx.delete on the raw
        // primitive is leaf-aware enough for v1; if a future processor
        // wants subtree-cleanup it would call repo.mutate.delete instead.
        await tx.delete(id)
      }
    }, {
      scope: ChangeScope.References,
      description: `processor: ${CLEANUP_ORPHAN_ALIASES_PROCESSOR}`,
    })
  },
})

// ──── Bundle ────

export const referencesPostCommitProcessors: ReadonlyArray<AnyPostCommitProcessor> = [
  parseReferencesProcessor,
  cleanupOrphanAliasesProcessor,
]
