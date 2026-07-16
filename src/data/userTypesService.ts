/** User-defined `'block-type'` blocks → the `typesFacet` `'user-data'`
 *  runtime-contribution bucket (user-defined-types Phase 1).
 *
 *  The reactive lifecycle (subscribe / pin / publish / reset+clear on
 *  dispose) lives in the shared `ProjectorRuntime` core, configured by
 *  `userTypesProjector` below. This file keeps only the type-side
 *  specifics: the builder (`tryBuildType`, which resolves
 *  `block-type:properties` refs through the schema projector's handle),
 *  the `contributionsEqual` dedup that breaks the feedback loop with the
 *  propertySchemas rebuild step, and the `getTypeBlockId` lookup.
 *
 *  Deliberately narrow: NO synchronous-append / withProvisional path.
 *  See user-defined-types/design.html §Lessons from PR #50 — callers
 *  that need an in-tx dependent on a freshly-registered type use a
 *  two-tx flow (commit the type-definition block; wait for the
 *  subscription rebuild via `repo.onTypesChange`; then open the
 *  dependent tx). */

import {
  type AnyPropertySchema,
  type TypeContribution,
} from '@/data/api'
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import type {
  DefinitionBlockProjector,
  ProjectorHandle,
} from '@/data/projectorRuntime'
import { blockTypePropertiesProp } from '@/data/properties'
import { BLOCK_TYPE_TYPE } from '@/data/blockTypes'
import { parseTypeDefinitionMetadata } from '@/data/typeDefinitionMetadata'
import { typesFacet } from '@/data/facets'
import { USER_SCHEMAS_PROJECTOR_ID } from '@/data/userSchemasService'
import type {ProjectedPropertyDefinition} from '@/data/propertyDefinitionRegistry'
import type {PropertySchemaResolver} from '@/data/internals/propertySchemaResolution'
import {resolveSelectedPropertyDefinition} from '@/data/internals/propertySchemaResolution'

/** Projector id for the user-defined block-type bridge. */
export const USER_TYPES_PROJECTOR_ID = 'user-types'

const USER_DATA_SOURCE_ID = 'user-data'

/** Build a TypeContribution from a user-authored block-type block.
 *  Delegates identity/display extraction to the shared
 *  `parseTypeDefinitionMetadata` (the codec-less type-definition parser):
 *  it degrades malformed display fields to defaults, rejects only a
 *  label-less row, and applies the §9 `block-type:type-id` claim rule — a
 *  differing claim is honored only with valid `/type/` seed provenance,
 *  else the id demotes to the block id, so a user-authored row always
 *  projects under its own id (no seeded `/type/` rows exist until C3).
 *  This file keeps only the behavioral part the parser deliberately omits:
 *  resolving `block-type:properties` refs through the schema projector's
 *  handle + the workspace-bound central resolver. Silently drops refList
 *  entries that don't resolve to the selected workspace definition and
 *  locally available behavior (those fill in on the next
 *  `onPropertySchemasChange` tick when the missing behavior publishes). */
const tryBuildType = (
  block: Block,
  schemas: ProjectorHandle<ProjectedPropertyDefinition> | undefined,
  resolver: PropertySchemaResolver,
): TypeContribution | null => {
  const metadata = parseTypeDefinitionMetadata(block.data)
  if (!metadata) {
    console.warn(`[UserTypesService] block ${block.id} has no usable label; skipping`)
    return null
  }
  const refIds = block.peekProperty(blockTypePropertiesProp) ?? []
  const properties: AnyPropertySchema[] = []
  for (const refId of refIds) {
    const definition = schemas?.contributionForBlockId(refId)
    if (!definition) continue
    const schema = resolveSelectedPropertyDefinition(definition.metadata, resolver)
    if (schema) properties.push(schema)
  }
  return {
    id: metadata.typeId,
    label: metadata.label,
    ...(metadata.description ? {description: metadata.description} : {}),
    ...(metadata.hideFromBlockDisplay ? {hideFromBlockDisplay: metadata.hideFromBlockDisplay} : {}),
    ...(metadata.hideFromCompletion ? {hideFromCompletion: metadata.hideFromCompletion} : {}),
    ...(metadata.color ? {color: metadata.color} : {}),
    properties,
  }
}

/** Field-wise equality on the contribution list. Element identity isn't
 *  useful because `tryBuildType` creates fresh objects per rebuild;
 *  compare the load-bearing fields and each property's behavioral contract.
 *  The central resolver returns a fresh identity-bearing schema on every
 *  rebuild, so whole-object identity would re-enter the schemas/types feedback
 *  loop even when the effective contract is unchanged. */
const contributionsEqual = (
  a: readonly TypeContribution[],
  b: readonly TypeContribution[],
): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const ac = a[i]
    const bc = b[i]
    if (ac.id !== bc.id || ac.label !== bc.label || ac.description !== bc.description) return false
    if (ac.hideFromBlockDisplay !== bc.hideFromBlockDisplay || ac.color !== bc.color) return false
    if (ac.hideFromCompletion !== bc.hideFromCompletion) return false
    const ap = ac.properties ?? []
    const bp = bc.properties ?? []
    if (ap.length !== bp.length) return false
    for (let j = 0; j < ap.length; j++) {
      const as = ap[j]
      const bs = bp[j]
      const ai = as as AnyPropertySchema & {
        readonly fieldId?: string
        readonly workspaceId?: string
        readonly seedKey?: string
      }
      const bi = bs as AnyPropertySchema & {
        readonly fieldId?: string
        readonly workspaceId?: string
        readonly seedKey?: string
      }
      if (
        as.name !== bs.name ||
        as.codec !== bs.codec ||
        !Object.is(as.defaultValue, bs.defaultValue) ||
        as.changeScope !== bs.changeScope ||
        ai.fieldId !== bi.fieldId ||
        ai.workspaceId !== bi.workspaceId ||
        ai.seedKey !== bi.seedKey
      ) return false
    }
  }
  return true
}

/** Descriptor wiring the type bridge into the shared projector
 *  lifecycle. Hydrates raw rows into `Block` facades so the builder can
 *  decode through `peekProperty`; depends on the schema projector
 *  (started first) to gate property refs by exact backing block, then uses
 *  the workspace-bound central resolver to publish only the selected
 *  identity-bearing schema; re-resolves on
 *  `onPropertySchemasChange` when a newly-arriving schema makes a
 *  previously-dropped ref resolvable. `dedup` short-circuits the
 *  feedback loop: the propertySchemas rebuild step fires BOTH
 *  propertySchemas AND types listeners, so an unconditional republish
 *  from our `onPropertySchemasChange` listener would re-trigger it. */
export const userTypesProjector: DefinitionBlockProjector<Block, TypeContribution> = {
  id: USER_TYPES_PROJECTOR_ID,
  metaType: BLOCK_TYPE_TYPE,
  targetFacet: typesFacet,
  sourceId: USER_DATA_SOURCE_ID,
  dependsOn: [USER_SCHEMAS_PROJECTOR_ID],
  keyOf: type => type.id,
  hydrate: (rows, ctx) => rows.map(row => ctx.repo.block(row.id)),
  project: (block, ctx) =>
    tryBuildType(
      block,
      ctx.handle(USER_SCHEMAS_PROJECTOR_ID) as ProjectorHandle<ProjectedPropertyDefinition> | undefined,
      ctx.repo.propertySchemaResolverFor(block.data.workspaceId),
    ),
  dedup: contributionsEqual,
  secondarySignal: (repo, rebuild) => repo.onPropertySchemasChange(rebuild),
}

/** Thin facade over the `'user-types'` projector. Holds no state of its
 *  own — the lifecycle + contribution list live in the projector's
 *  `ProjectorHandle`, reached through `repo.projectors`. */
export class UserTypesService {
  constructor(private readonly repo: Repo) {}

  /** Look up the source block id for a published type id. Returns
   *  undefined for kernel/plugin types (no backing block) or ids that
   *  aren't user-data registered. */
  getTypeBlockId(typeId: string): string | undefined {
    return this.repo.projectors.handle<TypeContribution>(USER_TYPES_PROJECTOR_ID)?.blockIdForKey(typeId)
  }
}
