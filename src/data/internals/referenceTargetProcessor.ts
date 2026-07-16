/**
 * `core.deriveReferenceTarget` — same-tx derivation of the LOCAL
 * `reference_target_id` column (properties-as-blocks migration, slice A;
 * PR #288 §5/§7).
 *
 * Watches `content`. When a row's whole content trims to exactly one
 * reference token (`((uuid))` or `[[alias]]`), resolves it — property-schema
 * name-winner map first, then the tx-aware generic alias lookup — and writes
 * the target id into `reference_target_id` in the same transaction
 * (`skipMetadata`: bumps the sync clock, not "last edited"). Detection
 * everywhere downstream is a column read, never a content parse.
 *
 * The column is local-only and derived per device: sync arrival re-derives
 * it in the materializer seam (`deriveReferenceTargetForArrival`), and undo
 * replay restores it from snapshots (same-tx processors are skipped on
 * replay).
 */

import {
  defineSameTxProcessor,
  type PropertySchemaResolution,
  type Tx,
} from '@/data/api'
import { parseExactReferenceBlockContent } from '@/data/referenceBlock'

export const DERIVE_REFERENCE_TARGET_PROCESSOR_NAME = 'core.deriveReferenceTarget'

/** Resolution seams shared by the same-tx processor and the sync
 *  materializer's derive-at-arrival: both must resolve identically or the
 *  column diverges across write paths (§5's determinism requirement). */
export interface ReferenceTargetLookups {
  /** Schema-name winner map: `[[alias]]` matching a property schema's name
   *  resolves to that schema's fieldId (the definition block id). Null when
   *  no schema wins the name (shadowed/ambiguous names included — a
   *  per-client guess would strand rows on a loser's fieldId). */
  resolveSchemaFieldId(workspaceId: string, name: string): string | null
  /** Generic alias fallback (`block_aliases` index): target block id, or
   *  null when nothing claims the alias. */
  aliasTargetId(alias: string, workspaceId: string): Promise<string | null>
  /** Whether the schema-name tier can actually SEE this workspace's
   *  definitions right now. The registry is scoped to the active/previous
   *  workspace, so for a background workspace `resolveSchemaFieldId` fails
   *  CLOSED — and stamping the alias fallback then would bind `[[status]]`
   *  to a page even though a definition named "status" exists; nothing
   *  later corrects it (the per-open sweep scans NULL columns only).
   *  Callers on paths with no same-tx registry guarantee (derive-at-arrival)
   *  must skip `[[alias]]` derivation entirely when this returns false and
   *  leave the column NULL for the per-open sweep. Optional: seams that
   *  guarantee a primed registry (the same-tx processor — `repo.tx` awaits
   *  `whenPropertyDefinitionsReady`) omit it. */
  schemaTierReady?(workspaceId: string): boolean
}

/** Derive the target for `content`, or:
 *  - `null` — content is not an exact reference (the column must clear);
 *  - `undefined` — content IS an exact `[[alias]]` reference but nothing
 *    resolves it (callers decide: keep a caller-provided id on create, else
 *    clear). A `((uuid))` block-ref resolves textually — no lookup. */
export const deriveReferenceTargetId = async (
  content: string,
  workspaceId: string,
  lookups: ReferenceTargetLookups,
): Promise<string | null | undefined> => {
  const exact = parseExactReferenceBlockContent(content)
  if (!exact) return null
  if (exact.kind === 'blockRef') return exact.id

  // Blind schema tier → the whole `[[alias]]` derivation defers (returns
  // "unresolvable"), INCLUDING the DB-backed alias fallback: stamping the
  // alias now would lose the winner race against a definition this client
  // just can't see yet, and non-NULL stamps are never revisited. NULL is
  // repaired by the per-open sweep once the registry primes.
  if (lookups.schemaTierReady?.(workspaceId) === false) return undefined

  const fieldId = lookups.resolveSchemaFieldId(workspaceId, exact.alias)
  if (fieldId !== null) return fieldId

  const aliasTarget = await lookups.aliasTargetId(exact.alias, workspaceId)
  return aliasTarget ?? undefined
}

/** Build the `ReferenceTargetLookups` for a same-tx processor: schema-name
 *  resolution from the tx-start-snapshotted registry (`ctx.resolvePropertySchemaName`),
 *  alias fallback from `tx.aliasLookup`. Shared by the derive processor
 *  itself and by plugin same-tx processors that rewrite `content` AFTER
 *  derivation already ran (merge retarget, deleted-block inlining) and so
 *  must recompute the column inline rather than leave it describing
 *  pre-rewrite content. No `schemaTierReady` gate: same-tx processors run
 *  after `repo.tx` awaits `whenPropertyDefinitionsReady`, so the registry is
 *  always primed here. */
export const sameTxReferenceTargetLookups = (
  tx: Tx,
  resolvePropertySchemaName: (
    workspaceId: string,
    name: string,
  ) => PropertySchemaResolution<unknown>,
): ReferenceTargetLookups => ({
  resolveSchemaFieldId: (workspaceId, name) => {
    const resolution = resolvePropertySchemaName(workspaceId, name)
    return resolution.status === 'resolved' ? resolution.schema.fieldId : null
  },
  aliasTargetId: async (alias, workspaceId) =>
    (await tx.aliasLookup(alias, workspaceId))?.id ?? null,
})

export const DERIVE_REFERENCE_TARGET_PROCESSOR = defineSameTxProcessor({
  name: DERIVE_REFERENCE_TARGET_PROCESSOR_NAME,
  watches: {kind: 'field', table: 'blocks', fields: ['content']},
  apply: async (event, ctx) => {
    const lookups = sameTxReferenceTargetLookups(ctx.tx, ctx.resolvePropertySchemaName)
    for (const changed of event.changedRows) {
      const row = changed.after
      // Tombstoned rows derive too (matches the arrival path): a content
      // edit while deleted would otherwise leave a stale column that a
      // later content-unchanged restore never repairs.
      if (row === null) continue
      const derivedTargetId = await deriveReferenceTargetId(
        row.content,
        row.workspaceId,
        lookups,
      )
      // Unresolvable-alias CREATE keeps a caller-provided id (field-row
      // machinery passes the fieldId directly when the name map can't see
      // it yet); everywhere else unresolvable clears — content is the
      // source, the column never outlives it.
      const targetId = derivedTargetId === undefined && changed.before === null
        ? row.referenceTargetId ?? null
        : derivedTargetId ?? null
      if ((row.referenceTargetId ?? null) === targetId) continue
      await ctx.tx.update(row.id, {referenceTargetId: targetId}, {skipMetadata: true})
    }
  },
})
