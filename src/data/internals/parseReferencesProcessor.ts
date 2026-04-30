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
 *   - scope: ChangeScope.References (separate undo bucket; uploads).
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
 */

import { z } from 'zod'
import {
  ChangeScope,
  definePostCommitProcessor,
  type BlockData,
  type BlockReference,
  type CommittedEvent,
  type ProcessorCtx,
} from '@/data/api'
import {
  parseReferences as parseAliasMarks,
  parseBlockRefs,
} from '@/utils/referenceParser'
import {
  ensureAliasTarget,
  ensureDailyNoteTarget,
  isDateAlias,
} from './targets'
import { aliasesProp } from './coreProperties'

interface PowerSyncDbReadSurface {
  getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>
  getAll<T>(sql: string, params?: unknown[]): Promise<T[]>
}

/** Resolve `alias` to an existing target block id in `workspaceId`,
 *  or null if no live row carries this alias yet. Reads committed
 *  state via `ctx.db` (the processor runs after the originating tx
 *  has committed, so committed reads are correct). */
const lookupAliasTarget = async (
  db: PowerSyncDbReadSurface,
  workspaceId: string,
  alias: string,
): Promise<string | null> => {
  // json_each over properties.alias; matches when any element equals alias.
  const row = await db.getOptional<{ id: string }>(
    `SELECT b.id
     FROM blocks b, json_each(json_extract(b.properties_json, '$.${aliasesProp.name}')) je
     WHERE b.workspace_id = ?
       AND b.deleted = 0
       AND je.value = ?
     LIMIT 1`,
    [workspaceId, alias],
  )
  return row?.id ?? null
}

/** Process one `(sourceId, content, workspaceId)` triple: parse refs,
 *  resolve / create alias targets, write `references` on source. Returns
 *  the list of alias-target ids inserted by THIS processor invocation
 *  (filtered to non-date — date results are intentionally excluded
 *  per §7.6). */
const processOne = async (
  ctx: ProcessorCtx,
  source: BlockData,
): Promise<string[]> => {
  const content = source.content
  const aliasMarks = parseAliasMarks(content)
  const blockRefMarks = parseBlockRefs(content)

  const aliasResults: Array<{ id: string; alias: string; inserted: boolean }> = []
  const dateResults: Array<{ id: string; alias: string }> = []
  const seenAliases = new Set<string>()

  for (const mark of aliasMarks) {
    if (seenAliases.has(mark.alias)) continue
    seenAliases.add(mark.alias)
    if (isDateAlias(mark.alias)) {
      // Daily note path — distinct deterministic id, never feeds cleanup.
      const result = await ensureDailyNoteTarget(ctx.tx, mark.alias, source.workspaceId)
      dateResults.push({id: result.id, alias: mark.alias})
      continue
    }
    // Non-date alias — try lookup-first to skip the deterministic-id
    // codec round-trip when an existing target already carries the
    // alias (e.g. typing `[[Inbox]]` for an Inbox someone else made
    // via the create-page UI; §7.5 race).
    const existing = await lookupAliasTarget(
      ctx.db as PowerSyncDbReadSurface, source.workspaceId, mark.alias,
    )
    if (existing !== null) {
      aliasResults.push({id: existing, alias: mark.alias, inserted: false})
      continue
    }
    const ensured = await ensureAliasTarget(ctx.tx, mark.alias, source.workspaceId)
    aliasResults.push({id: ensured.id, alias: mark.alias, inserted: ensured.inserted})
  }

  const blockRefs: BlockReference[] = []
  const seenBlockRefs = new Set<string>()
  for (const mark of blockRefMarks) {
    if (seenBlockRefs.has(mark.blockId)) continue
    seenBlockRefs.add(mark.blockId)
    blockRefs.push({id: mark.blockId, alias: mark.blockId})
  }

  const references: BlockReference[] = [
    ...aliasResults.map(r => ({id: r.id, alias: r.alias})),
    ...dateResults.map(r => ({id: r.id, alias: r.alias})),
    ...blockRefs,
  ]

  // Only update `references` if the set actually changed — avoids a
  // no-op write that would re-fire field-watching processors and
  // produce a useless row_events / ps_crud entry. Compare as JSON for
  // structural equality.
  const currentJson = JSON.stringify(source.references)
  const nextJson = JSON.stringify(references)
  if (currentJson !== nextJson) {
    await ctx.tx.update(source.id, {references}, {skipMetadata: true})
  }

  // Only non-date, this-tx-inserted ids feed cleanup. Date results are
  // excluded by routing; non-inserted (live-hit) results are excluded
  // because the target row pre-existed and is someone else's to manage.
  return aliasResults.filter(r => r.inserted).map(r => r.id)
}

export const parseReferencesProcessor = definePostCommitProcessor({
  name: 'core.parseReferences',
  scope: ChangeScope.References,
  watches: { kind: 'field', table: 'blocks', fields: ['content'] },
  apply: async (event: CommittedEvent<undefined>, ctx: ProcessorCtx) => {
    const allNewlyInsertedAliasTargetIds: string[] = []
    for (const row of event.changedRows) {
      // Skip hard-deletes (after === null) — nothing to parse.
      if (row.after === null) continue
      // Skip soft-deletes (after.deleted === true) — same reason.
      if (row.after.deleted) continue
      const inserted = await processOne(ctx, row.after)
      allNewlyInsertedAliasTargetIds.push(...inserted)
    }
    if (allNewlyInsertedAliasTargetIds.length > 0) {
      ctx.tx.afterCommit(
        'core.cleanupOrphanAliases',
        { newlyInsertedAliasTargetIds: allNewlyInsertedAliasTargetIds },
        { delayMs: 4000 },
      )
    }
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
  db: PowerSyncDbReadSurface,
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
  scope: ChangeScope.References,
  watches: { kind: 'explicit' },
  scheduledArgsSchema: cleanupArgsSchema,
  apply: async (event: CommittedEvent<CleanupArgs>, ctx: ProcessorCtx) => {
    const ids = event.scheduledArgs?.newlyInsertedAliasTargetIds ?? []
    for (const id of ids) {
      const stillReferenced = await anyBlockReferences(
        ctx.db as PowerSyncDbReadSurface, id,
      )
      if (stillReferenced) continue
      // No block references it — orphan. Soft-delete (the §7 cleanup
      // is leaf-only by construction; the alias target was created
      // empty so it has no children to cascade). tx.delete on the raw
      // primitive is leaf-aware enough for v1; if a future processor
      // wants subtree-cleanup it would call repo.mutate.delete instead.
      await ctx.tx.delete(id)
    }
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

