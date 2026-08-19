/** User-defined `'block-type'` blocks → the `projectedTypeDefinitionsFacet`
 *  `'user-data'` runtime-contribution bucket (user-defined-types Phase 1).
 *
 *  The reactive lifecycle (subscribe / pin / publish / reset+clear on
 *  dispose) lives in the shared `ProjectorRuntime` core, configured by
 *  `userTypesProjector` below. This file keeps only the type-side
 *  specifics: the builder (`tryBuildType`, which parses codec-less
 *  identity/display metadata + resolves `block-type:properties` refs
 *  through the schema projector's handle into a `ProjectedTypeDefinition`)
 *  and the `projectedDefinitionsEqual` dedup that breaks the feedback loop
 *  with the propertySchemas rebuild step. The projector publishes the
 *  projected rows; the facet bridge folds them (+ `typeSeedsFacet`) into the
 *  merged, §9-resolved `repo.types` via `buildTypeDefinitionRegistry`, so the
 *  declaration-authoritative registry — not this projector — decides
 *  membership ids and `getTypeBlockId` reads that registry.
 *
 *  Deliberately narrow: NO synchronous-append / withProvisional path.
 *  See user-defined-types/design.html §Lessons from PR #50 — callers
 *  that need an in-tx dependent on a freshly-registered type use a
 *  two-tx flow (commit the type-definition block; wait for the
 *  subscription rebuild via `repo.onTypesChange`; then open the
 *  dependent tx). */

import {
  type AnyPropertySchema,
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
import { projectedTypeDefinitionsFacet } from '@/data/facets'
import { USER_SCHEMAS_PROJECTOR_ID } from '@/data/userSchemasService'
import type {ProjectedPropertyDefinition} from '@/data/propertyDefinitionRegistry'
import type {ProjectedTypeDefinition} from '@/data/typeDefinitionRegistry'
import type {PropertySchemaResolver} from '@/data/internals/propertySchemaResolution'
import {resolveSelectedPropertyDefinition} from '@/data/internals/propertySchemaResolution'

/** Projector id for the user-defined block-type bridge. */
export const USER_TYPES_PROJECTOR_ID = 'user-types'

const USER_DATA_SOURCE_ID = 'user-data'

/** Build a `ProjectedTypeDefinition` from a user-authored block-type block:
 *  the codec-less identity/display metadata (`parseTypeDefinitionMetadata`,
 *  which degrades malformed display fields to defaults and rejects only a
 *  label-less row) plus the behavior the parser deliberately omits — the
 *  resolved `block-type:properties` schemas.
 *
 *  This projector no longer decides membership ids: it publishes the FULL
 *  parsed metadata (including the §9 `block-type:type-id` claim + any `/type/`
 *  seed key) keyed by the BLOCK id, and `buildTypeDefinitionRegistry` (the
 *  declaration-authoritative id-keyed registry) resolves the claim downstream —
 *  binding a claim only to a real declared seed and refusing any
 *  forged/foreign/retired seed-key row that claims an id a live declaration owns
 *  (the declaration always wins), so no synced/imported row can hijack a
 *  kernel/plugin id. Property resolution: each ref is
 *  resolved through the schema projector's handle + the workspace-bound central
 *  resolver; refList entries that don't resolve to the selected workspace
 *  definition and locally available behavior are silently dropped (they fill in
 *  on the next `onPropertySchemasChange` tick when the missing behavior
 *  publishes). */
const tryBuildType = (
  block: Block,
  schemas: ProjectorHandle<ProjectedPropertyDefinition> | undefined,
  resolver: PropertySchemaResolver,
): ProjectedTypeDefinition | null => {
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
  return {metadata, properties}
}

/** Field-wise equality on the projected-definition list. Element identity isn't
 *  useful because `tryBuildType` re-parses metadata and re-resolves schemas into
 *  fresh objects per rebuild; compare the load-bearing metadata facts (the
 *  identity/claim keys the registry consumes + the published display fields) and
 *  each property's behavioral contract. The central resolver returns a fresh
 *  identity-bearing schema on every rebuild, so whole-object identity would
 *  re-enter the schemas/types feedback loop even when the effective contract is
 *  unchanged. */
const projectedDefinitionsEqual = (
  a: readonly ProjectedTypeDefinition[],
  b: readonly ProjectedTypeDefinition[],
): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const am = a[i].metadata
    const bm = b[i].metadata
    if (
      am.blockId !== bm.blockId ||
      am.typeId !== bm.typeId ||
      am.seedKey !== bm.seedKey ||
      am.label !== bm.label ||
      am.description !== bm.description ||
      am.color !== bm.color ||
      am.hideFromBlockDisplay !== bm.hideFromBlockDisplay ||
      am.hideFromCompletion !== bm.hideFromCompletion
    ) return false
    const ap = a[i].properties
    const bp = b[i].properties
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
export const userTypesProjector: DefinitionBlockProjector<Block, ProjectedTypeDefinition> = {
  id: USER_TYPES_PROJECTOR_ID,
  metaType: BLOCK_TYPE_TYPE,
  targetFacet: projectedTypeDefinitionsFacet,
  sourceId: USER_DATA_SOURCE_ID,
  dependsOn: [USER_SCHEMAS_PROJECTOR_ID],
  keyOf: def => def.metadata.blockId,
  hydrate: (rows, ctx) => rows.map(row => ctx.repo.block(row.id)),
  project: (block, ctx) =>
    tryBuildType(
      block,
      ctx.handle(USER_SCHEMAS_PROJECTOR_ID) as ProjectorHandle<ProjectedPropertyDefinition> | undefined,
      ctx.repo.propertySchemaResolverFor(block.data.workspaceId),
    ),
  dedup: projectedDefinitionsEqual,
  secondarySignal: (repo, rebuild) => repo.onPropertySchemasChange(rebuild),
}

/** Thin facade over the `'user-types'` projector. Holds no state of its
 *  own — the lifecycle + contribution list live in the projector's
 *  `ProjectorHandle`, reached through `repo.projectors`. */
export class UserTypesService {
  constructor(private readonly repo: Repo) {}

  /** Look up the backing definition-block id for a published type id, through
   *  the declaration-authoritative type-definition registry
   *  (`blockIdByTypeId`). A user type resolves to its own block; a materialized
   *  code seed resolves to its deterministic backing block (Slice C4+);
   *  kernel/plugin code types with no backing block, and an unmaterialized seed,
   *  return undefined. */
  getTypeBlockId(typeId: string): string | undefined {
    return this.repo.typeDefinitions?.blockIdByTypeId.get(typeId)
  }
}
