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
 * identity). On PRIME there is no comparable previous snapshot — it is null or
 * belongs to another workspace — so the durable per-workspace baseline
 * (`propertyDefinitionBaseline.ts`) supplies the before-state instead, which is
 * what catches a change synced in while this device was looking elsewhere
 * (#780). The multi-device rename RACE (a block edited offline across a rename
 * syncs up under a key no registry knows) is slice C's reconcile; this one-shot
 * pass can't reach it.
 */

import type { ResolvedPropertySchema } from '@/data/api'
import type { PropertyDefinitionRegistrySnapshot } from '@/data/propertyDefinitionRegistry'
import {
  propertyDefinitionFacts,
  type PropertyDefinitionFactsByFieldId,
} from './propertyDefinitionBaseline'

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

/** Diff two sets of definition facts by durable fieldId. A fieldId absent from
 *  `previous` is an ADDED definition, not a rename — nothing to re-key. */
export const changedPropertyDefinitionFacts = (
  previous: PropertyDefinitionFactsByFieldId,
  next: PropertyDefinitionFactsByFieldId,
): PropertyDefinitionChange[] => {
  const changes: PropertyDefinitionChange[] = []
  for (const [fieldId, nextFacts] of next) {
    const previousFacts = previous.get(fieldId)
    if (!previousFacts) continue
    const nameChanged = previousFacts.name !== nextFacts.name
    const codecChanged =
      previousFacts.codecType !== undefined
      && nextFacts.codecType !== undefined
      && previousFacts.codecType !== nextFacts.codecType
    if (!nameChanged && !codecChanged) continue
    changes.push({
      fieldId,
      oldName: previousFacts.name,
      newName: nextFacts.name,
      codecChanged,
    })
  }
  return changes
}

/** Diff two registry snapshots of the SAME workspace by durable fieldId.
 *  A workspace switch (different `workspaceId`) is never a migration —
 *  and neither is a null side, which is the PRIME case: the durable
 *  per-workspace baseline (`propertyDefinitionBaseline.ts`) is what
 *  answers there. */
export const changedPropertyDefinitions = (
  previous: PropertyDefinitionRegistrySnapshot | null | undefined,
  next: PropertyDefinitionRegistrySnapshot | null | undefined,
): PropertyDefinitionChange[] => {
  if (!previous || !next) return []
  if (previous.workspaceId !== next.workspaceId) return []
  return changedPropertyDefinitionFacts(
    propertyDefinitionFacts(previous), propertyDefinitionFacts(next),
  )
}
