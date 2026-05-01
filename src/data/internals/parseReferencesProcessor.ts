/**
 * `core.parseReferences` + `core.cleanupOrphanAliases` post-commit
 * processors (spec §7).
 *
 * `core.parseReferences`
 *   - watches: { kind: 'field', table: 'blocks', fields: ['content'] }
 *   - For each changedRow whose `content` changed (insert or update),
 *     parse `[[alias]]` and `((uuid))` references.
 *   - Resolve aliases to existing target ids via a workspace-scoped
 *     SQL lookup (committed-state read via ctx.db). On miss, create
 *     the target via ensureAliasTarget / ensureDailyNoteTarget.
 *   - Write `tx.update(sourceId, {references}, {skipMetadata: true})`.
 *   - If any non-date alias target was newly inserted (or restored),
 *     schedule `core.cleanupOrphanAliases` with
 *     `{newlyInsertedAliasTargetIds}` after delayMs: 4000.
 *   - Opens its own tx via `ctx.repo.tx(..., {scope:
 *     ChangeScope.References})` — separate undo bucket; uploads.
 *
 * `core.cleanupOrphanAliases`
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
  type BlockData,
  type BlockReference,
  type CommittedEvent,
  type ProcessorCtx,
  type ProcessorReadDb,
  type Tx,
} from '@/data/api'
import {
  parseReferences as parseAliasMarks,
  parseBlockRefs,
} from '@/utils/referenceParser'
import {
  computeAliasSeatId,
  computeDailyNoteId,
  ensureAliasTarget,
  ensureDailyNoteTarget,
  isDateAlias,
} from './targets'

/** Resolve `alias` to an existing target block id in `workspaceId`,
 *  or null if no live row carries this alias yet. Reads committed
 *  state via `ctx.db` (the processor runs after the originating tx
 *  has committed, so committed reads are correct). Goes through
 *  `block_aliases` (the trigger-maintained index in clientSchema.ts),
 *  which keeps this lookup O(log n) instead of scanning the workspace
 *  partition. The `b.deleted = 0` filter is defensive — triggers wipe
 *  index rows on soft-delete already. */
const lookupAliasTarget = async (
  db: ProcessorReadDb,
  workspaceId: string,
  alias: string,
): Promise<string | null> => {
  const row = await db.getOptional<{ id: string }>(
    `SELECT b.id
     FROM block_aliases ba
     JOIN blocks b ON b.id = ba.block_id
     WHERE ba.workspace_id = ?
       AND ba.alias = ?
       AND b.deleted = 0
     ORDER BY b.created_at
     LIMIT 1`,
    [workspaceId, alias],
  )
  return row?.id ?? null
}

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
  /** Dates to be created via `ensureDailyNoteTarget` in the write phase. */
  datesToEnsure: string[]
  /** True iff the planned `references` differ from what's currently on
   *  the row — used to skip a no-op write that would re-fire the
   *  field-watcher and produce a useless row_events / ps_crud entry. */
  referencesChanged: boolean
}

/** Read phase: parse refs, resolve existing alias targets via committed-
 *  state lookup, and produce a SourcePlan describing what the write
 *  phase needs to do. No tx opened here — `db` is the bare PowerSync
 *  surface, reads see committed state from the originating tx. */
const buildSourcePlan = async (
  db: ProcessorReadDb,
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
    if (isDateAlias(mark.alias)) {
      // Daily note path — distinct deterministic id, never feeds cleanup.
      // Always-present id (deterministic from date+workspace); the write
      // phase will ensureDailyNoteTarget which is idempotent.
      const id = computeDailyNoteId(mark.alias, source.workspaceId)
      dateRefs.push({id, alias: mark.alias})
      datesToEnsure.push(mark.alias)
      continue
    }
    // Non-date alias — try lookup-first to skip the deterministic-id
    // codec round-trip when an existing target already carries the
    // alias (e.g. typing `[[Inbox]]` for an Inbox someone else made
    // via the create-page UI; §7.5 race).
    const existing = await lookupAliasTarget(db, source.workspaceId, mark.alias)
    if (existing !== null) {
      aliasRefs.push({id: existing, alias: mark.alias})
      continue
    }
    // Will be created by ensureAliasTarget in the write phase. The id
    // is deterministic from (alias, workspaceId), so we can predict it
    // here for the references column.
    const id = computeAliasSeatId(mark.alias, source.workspaceId)
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

  const references: BlockReference[] = [...aliasRefs, ...dateRefs, ...blockRefs]
  const referencesChanged = JSON.stringify(source.references) !== JSON.stringify(references)

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
  plan: SourcePlan,
): Promise<string[]> => {
  const newlyInserted: string[] = []
  for (const date of plan.datesToEnsure) {
    await ensureDailyNoteTarget(tx, date, plan.workspaceId)
  }
  for (const alias of plan.aliasesToEnsure) {
    const ensured = await ensureAliasTarget(tx, alias, plan.workspaceId)
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
  name: 'core.parseReferences',
  watches: { kind: 'field', table: 'blocks', fields: ['content'] },
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
      plans.push(await buildSourcePlan(ctx.db, row.after))
    }
    if (!plans.some(planNeedsWrite)) return

    // Write phase — single tx, atomic for refs + targets + afterCommit.
    await ctx.repo.tx(async tx => {
      const allNewlyInserted: string[] = []
      for (const plan of plans) {
        if (!planNeedsWrite(plan)) continue
        const inserted = await applySourcePlan(tx, plan)
        allNewlyInserted.push(...inserted)
      }
      if (allNewlyInserted.length > 0) {
        tx.afterCommit(
          'core.cleanupOrphanAliases',
          { newlyInsertedAliasTargetIds: allNewlyInserted },
          { delayMs: 4000 },
        )
      }
    }, {
      scope: ChangeScope.References,
      description: 'processor: core.parseReferences',
    })
  },
})

// ──── core.cleanupOrphanAliases ────

const cleanupArgsSchema = z.object({
  newlyInsertedAliasTargetIds: z.array(z.string()),
})

interface CleanupArgs {
  newlyInsertedAliasTargetIds: string[]
}

declare module '@/data/api' {
  interface PostCommitProcessorRegistry {
    'core.cleanupOrphanAliases': CleanupArgs
  }
}

/** Returns true iff `id` is referenced by any live block's
 *  `references_json` entry. */
const anyBlockReferences = async (
  db: ProcessorReadDb,
  id: string,
): Promise<boolean> => {
  const row = await db.getOptional<{ id: string }>(
    `SELECT b.id
     FROM blocks b, json_each(b.references_json) je
     WHERE b.deleted = 0
       AND json_extract(je.value, '$.id') = ?
     LIMIT 1`,
    [id],
  )
  return row !== null
}

export const cleanupOrphanAliasesProcessor = definePostCommitProcessor<CleanupArgs>({
  name: 'core.cleanupOrphanAliases',
  watches: { kind: 'explicit' },
  scheduledArgsSchema: cleanupArgsSchema,
  apply: async (event: CommittedEvent<CleanupArgs>, ctx: ProcessorCtx) => {
    const ids = event.scheduledArgs?.newlyInsertedAliasTargetIds ?? []
    if (ids.length === 0) return

    // Read phase — gather actual orphans without holding a writer slot.
    const orphans: string[] = []
    for (const id of ids) {
      if (!(await anyBlockReferences(ctx.db, id))) orphans.push(id)
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
      description: 'processor: core.cleanupOrphanAliases',
    })
  },
})

// ──── Bundle ────

import type { AnyPostCommitProcessor } from '@/data/api'

/** All kernel post-commit processors, registered into Repo by default
 *  at construction time (mirrors KERNEL_MUTATORS in kernelMutators.ts).
 *  Registry replacement via setFacetRuntime starts with these and
 *  layers in plugin contributions. */
export const KERNEL_PROCESSORS: ReadonlyArray<AnyPostCommitProcessor> = [
  parseReferencesProcessor,
  cleanupOrphanAliasesProcessor,
]
