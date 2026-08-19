/**
 * Schema-change migration detection for properties-as-blocks (PR #288 §7/§9,
 * slice B2). Renames and codec changes are MIGRATIONS, not edits:
 *
 *  - After a rename the cell is still keyed by the OLD name — the registry
 *    no longer knows that key, materialize skips unknown names, and every
 *    schema-aware reader silently falls back to `defaultValue` while the
 *    tree shows the real value (mass silent unset). Field-row content also
 *    goes stale (`[[old]]`), which would make every re-derive-by-content
 *    path (cross-workspace copy, markdown round-trip) bind the dead name.
 *
 *  - After a codec/preset change every existing value child may become
 *    unparseable under the new codec; leaning on the projection's
 *    remove-on-invalid behavior would present a silent fleet-wide unset as
 *    "default". The pass re-encodes what converts and REPORTS what doesn't.
 *
 * Detection rides the registry rebuild: the facet bridge diffs the previous
 * vs incoming `PropertyDefinitionRegistrySnapshot` per fieldId (durable
 * identity), so every rename source — panel edit, outline edit of the
 * definition block, a synced-in rename from another device — funnels through
 * one seam. The multi-device rename RACE (a block edited offline across a
 * rename syncs up under a key no registry knows) is slice C's reconcile;
 * this one-shot pass can't reach it.
 */

import type { ResolvedPropertySchema } from '@/data/api'
import type { PropertyDefinitionRegistrySnapshot } from '@/data/propertyDefinitionRegistry'

export interface PropertyDefinitionChange {
  readonly fieldId: string
  readonly oldName: string
  readonly newName: string
  /** Codec TYPE changed (text → number, …). Conservative trigger: config
   *  tweaks that keep the codec type re-encode lazily through the ordinary
   *  idempotent materialize/project round-trip instead. */
  readonly codecChanged: boolean
}

/** One change, resolved to the schema the workspace selected for its
 *  fieldId — captured at `Repo.schedulePropertyDefinitionMigrations` time,
 *  NOT re-resolved when the deferred batch finally runs.
 *
 *  `Repo.propertySchemaResolverFor` only serves the ACTIVE workspace or the
 *  immediately-previous one (one-deep retention) and fails closed for any
 *  other workspace. The migration batch is deferred to a deep-idle job, so by
 *  the time it runs the user may have switched workspaces twice more —
 *  re-resolving THEN would silently return zero plans and drop the migration
 *  with no retry. Resolution is guaranteed to succeed at SCHEDULE time
 *  (`changes` comes from this workspace's own registry rebuild, which just
 *  primed its snapshot), so the plan is captured there instead. A change
 *  whose fieldId doesn't resolve then (shadowed / unavailable, §6) is
 *  dropped — same skip the old run-time check performed, just moved earlier. */
export interface PropertyDefinitionMigrationPlan {
  readonly change: PropertyDefinitionChange
  readonly schema: ResolvedPropertySchema<unknown>
}

/** Diff two registry snapshots of the SAME workspace by durable fieldId.
 *  A workspace switch (different `workspaceId`) is never a migration. */
export const changedPropertyDefinitions = (
  previous: PropertyDefinitionRegistrySnapshot | null | undefined,
  next: PropertyDefinitionRegistrySnapshot | null | undefined,
): PropertyDefinitionChange[] => {
  if (!previous || !next) return []
  if (previous.workspaceId !== next.workspaceId) return []
  const changes: PropertyDefinitionChange[] = []
  for (const [fieldId, nextMetadata] of next.definitionsByFieldId) {
    const previousMetadata = previous.definitionsByFieldId.get(fieldId)
    if (!previousMetadata) continue
    const nameChanged = previousMetadata.name !== nextMetadata.name
    const previousCodecType = previous.schemasByFieldId.get(fieldId)?.codec.type
    const nextCodecType = next.schemasByFieldId.get(fieldId)?.codec.type
    const codecChanged =
      previousCodecType !== undefined
      && nextCodecType !== undefined
      && previousCodecType !== nextCodecType
    if (!nameChanged && !codecChanged) continue
    changes.push({
      fieldId,
      oldName: previousMetadata.name,
      newName: nextMetadata.name,
      codecChanged,
    })
  }
  return changes
}

/** Definitions PRESENT in `next` with no previous entry — new schemas whose
 *  name may already appear as `[[name]]` rows that derived to NULL before
 *  the definition existed (PR #288 §9's arrival-order hole). A null
 *  `previous` (boot's first snapshot) is deliberately not "everything added"
 *  — the once-per-workspace catch-up pass covers boot, running after
 *  registry readiness. */
export const addedPropertyDefinitionNames = (
  previous: PropertyDefinitionRegistrySnapshot | null | undefined,
  next: PropertyDefinitionRegistrySnapshot | null | undefined,
): string[] => {
  if (!previous || !next) return []
  if (previous.workspaceId !== next.workspaceId) return []
  const names: string[] = []
  for (const [fieldId, metadata] of next.definitionsByFieldId) {
    if (!previous.definitionsByFieldId.has(fieldId)) names.push(metadata.name)
  }
  return names
}
