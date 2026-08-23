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
 * identity), falling back to `propertyDefinitionBaseline.ts` on a PRIME, where
 * there is no comparable previous snapshot. The multi-device rename RACE (a
 * block edited offline across a rename syncs up under a key no registry knows)
 * is slice C's reconcile; this one-shot pass can't reach it.
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

/** One change, resolved to the schema the workspace selected for its fieldId —
 *  captured when the migration is SCHEDULED, not when the deferred batch runs.
 *  `Repo.propertySchemaResolverFor` serves only the active or immediately-
 *  previous workspace and fails closed otherwise, so a batch that re-resolved
 *  after two more workspace switches would return zero plans and drop the
 *  migration with no retry. A fieldId that doesn't resolve at capture time
 *  (shadowed / unavailable, §6) is dropped. */
export interface PropertyDefinitionMigrationPlan {
  readonly change: PropertyDefinitionChange
  readonly schema: ResolvedPropertySchema<unknown>
}

/** The identity-stable facts a definition-migration diff compares, per durable
 *  fieldId. `codecType` is absent when the registry carried the definition's
 *  metadata but no resolved schema (its preset plugin hasn't loaded). */
export interface PropertyDefinitionFacts {
  readonly name: string
  readonly codecType?: string
}

export type PropertyDefinitionFactsByFieldId = ReadonlyMap<string, PropertyDefinitionFacts>

/** The diff inputs a registry snapshot contributes, by durable fieldId.
 *
 *  SEED-provenanced definitions are excluded. Their effective name flips with
 *  whether the seed is currently registered — `effectivePropertyDefinitionName`
 *  answers the DECLARED name while it is and the STORED one otherwise — so a
 *  build that catches a dynamic extension mid-load would diff a phantom rename
 *  and re-key every consuming cell onto a name the app stops resolving a moment
 *  later. Nothing is lost: seeds are code-owned and non-renamable, so a user
 *  rename can never be the change detected here, and a seed's DECLARED name or
 *  codec changing across a client upgrade is a deliberate migration rather than
 *  something to fall out of this diff. `seedKey` comes from the row's own
 *  deterministic-id provenance check, so it is stable across builds whether or
 *  not the seed is registered on this one. */
export const propertyDefinitionFacts = (
  snapshot: PropertyDefinitionRegistrySnapshot,
): Map<string, PropertyDefinitionFacts> => {
  const facts = new Map<string, PropertyDefinitionFacts>()
  for (const [fieldId, metadata] of snapshot.definitionsByFieldId) {
    if (metadata.seedKey !== undefined) continue
    const codecType = snapshot.schemasByFieldId.get(fieldId)?.codec.type
    facts.set(fieldId, codecType === undefined
      ? {name: metadata.name}
      : {name: metadata.name, codecType})
  }
  return facts
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

/**
 * Drop a rename whose OLD or NEW name a DIFFERENT definition owns and is not
 * itself migrating away from. Both halves protect a cell key that isn't this
 * definition's to write:
 *
 *  - NEW name: re-keying under a name someone else owns overwrites that
 *    owner's cell projection with the wrong value (found by Codex on PR #386)
 *    — the renamer is likely shadowed there, not the winner.
 *  - OLD name: a rename UN-SHADOWS any definition that shared the old name
 *    (§6), so afterwards that name answers to the sibling. Dropping it would
 *    strand the sibling's cell — and in the deferred batch, whose re-key is an
 *    ordinary `tx.update` rather than a settled write, MATERIALIZE runs on it
 *    in the same tx, reads the missing key as a user deletion, and TOMBSTONES
 *    the sibling's field rows and value children.
 *
 * Either way the contested case belongs to the shadowing model's reconcile
 * (#389 item 8), not to a one-shot re-key. A SWAP (`a<->b`) is preserved: each
 * contested name's owner is itself migrating in the same batch. A codec-only
 * change passes trivially — both its names are its own.
 *
 * Shared by both writers of a rename re-key, because the refusal is a property
 * of the RENAME, not of the path that noticed it. `ownerOfName` is whatever
 * registry view the caller resolves against; for the same-tx processor that is
 * the tx-start snapshot, where the old name still maps to the renamer itself,
 * so the OLD-name half is a no-op there.
 */
export const withoutContestedRenames = <T extends {
  readonly fieldId: string
  readonly oldName: string
  readonly newName: string
}>(
  candidates: readonly T[],
  ownerOfName: (name: string) => string | undefined,
): T[] => {
  const migrating = new Set(candidates.map(candidate => candidate.fieldId))
  const uncontested = (name: string, self: string): boolean => {
    const owner = ownerOfName(name)
    return owner === undefined || owner === self || migrating.has(owner)
  }
  return candidates.filter(candidate =>
    uncontested(candidate.newName, candidate.fieldId)
    && uncontested(candidate.oldName, candidate.fieldId))
}
