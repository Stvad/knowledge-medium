import type {
  AnyPropertySchema,
} from '@/data/api'
import {propertyDefinitionBlockId} from '@/data/definitionSeeds'
import type {PropertyDefinitionMetadata} from '@/data/propertyDefinitionMetadata'
import type {AnyPropertySeedDeclaration} from '@/data/propertySeeds'

/** A block-built behavioral entry kept beside its durable field identity.
 * The public ambient registry is name-keyed; this internal form prevents that
 * lossy projection from becoming the resolver's source of identity. */
export interface ProjectedPropertyDefinition {
  readonly metadata: PropertyDefinitionMetadata
  readonly schema?: AnyPropertySchema
}

export interface PropertyDefinitionRegistrySnapshot {
  readonly workspaceId: string
  readonly schemas: ReadonlyMap<string, AnyPropertySchema>
  readonly definitionsByFieldId: ReadonlyMap<string, PropertyDefinitionMetadata>
  readonly definitionsByName: ReadonlyMap<string, readonly PropertyDefinitionMetadata[]>
  readonly schemasByFieldId: ReadonlyMap<string, AnyPropertySchema>
  readonly seedsByKey: ReadonlyMap<string, AnyPropertySeedDeclaration>
  readonly seedsByName: ReadonlyMap<string, readonly AnyPropertySeedDeclaration[]>
}

export interface BuildPropertyDefinitionRegistryArgs {
  readonly workspaceId: string
  /** Transitional direct registrations/type lift. Removed in Slice B4. */
  readonly legacySchemas: ReadonlyMap<string, AnyPropertySchema>
  readonly projectedDefinitions: ReadonlyMap<string, ProjectedPropertyDefinition>
  readonly seeds: readonly AnyPropertySeedDeclaration[]
}

const pushGrouped = <T>(map: Map<string, T[]>, key: string, value: T): void => {
  const values = map.get(key) ?? []
  values.push(value)
  map.set(key, values)
}

const indexSeeds = (seeds: readonly AnyPropertySeedDeclaration[]) => {
  const byKey = new Map<string, AnyPropertySeedDeclaration>()
  const byName = new Map<string, AnyPropertySeedDeclaration[]>()
  for (const seed of seeds) {
    if (byKey.has(seed.seedKey)) {
      throw new Error(`[property definitions] duplicate seed key ${JSON.stringify(seed.seedKey)}`)
    }
    byKey.set(seed.seedKey, seed)
    pushGrouped(byName, seed.name, seed)
  }
  return {byKey, byName}
}

/** Stage-0 behavioral registry used before a workspace is pinned. It exposes
 * declarations as plain entries but cannot produce identity-bearing values. */
export const buildUnboundPropertySchemas = (
  legacySchemas: ReadonlyMap<string, AnyPropertySchema>,
  seeds: readonly AnyPropertySeedDeclaration[],
): ReadonlyMap<string, AnyPropertySchema> => {
  const schemas = new Map(legacySchemas)
  const {byName} = indexSeeds(seeds)
  for (const namedSeeds of byName.values()) {
    if (namedSeeds.length === 1) schemas.set(namedSeeds[0]!.name, namedSeeds[0]!)
  }
  return schemas
}

/** Build one immutable-by-replacement workspace snapshot. Source precedence is
 * explicit during the cutover: block-built behavior replaces transitional
 * direct registrations, then a unique local declaration replaces its block
 * fallback. B2 adds name-winner filtering before boundary use. */
export const buildPropertyDefinitionRegistry = (
  args: BuildPropertyDefinitionRegistryArgs,
): PropertyDefinitionRegistrySnapshot => {
  const definitionsByFieldId = new Map<string, PropertyDefinitionMetadata>()
  const definitionsByNameMutable = new Map<string, PropertyDefinitionMetadata[]>()
  const schemasByFieldId = new Map<string, AnyPropertySchema>()
  for (const projected of args.projectedDefinitions.values()) {
    const definition = projected.metadata
    if (definition.workspaceId !== args.workspaceId) continue
    definitionsByFieldId.set(definition.fieldId, definition)
    if (projected.schema) schemasByFieldId.set(definition.fieldId, projected.schema)
    pushGrouped(definitionsByNameMutable, definition.name, definition)
  }
  for (const definitions of definitionsByNameMutable.values()) {
    definitions.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
      return a.fieldId < b.fieldId ? -1 : a.fieldId > b.fieldId ? 1 : 0
    })
  }

  const {byKey: seedsByKey, byName: seedsByNameMutable} = indexSeeds(args.seeds)

  const schemas = new Map(args.legacySchemas)
  for (const projected of args.projectedDefinitions.values()) {
    if (!projected.schema) continue
    const definition = projected.metadata
    if (!definitionsByFieldId.has(definition.fieldId)) continue
    const name = definition.name
    schemas.set(name, name === projected.schema.name
      ? projected.schema
      : {...projected.schema, name})
  }
  for (const namedSeeds of seedsByNameMutable.values()) {
    // Multiple local declarations with one display name need synced metadata
    // before a fleet-wide winner can be selected. Do not let load order choose.
    if (namedSeeds.length !== 1) continue
    const seed = namedSeeds[0]!
    const fieldId = propertyDefinitionBlockId(args.workspaceId, seed.seedKey)
    const definition = definitionsByFieldId.get(fieldId)
    // A deterministic-id occupant without the expected provenance is a hard
    // identity collision, not a synthesized seed entry.
    if (definition && definition.seedKey !== seed.seedKey) continue
    const name = definition?.name ?? seed.name
    schemas.set(name, name === seed.name ? seed : {...seed, name})
  }

  return {
    workspaceId: args.workspaceId,
    schemas,
    definitionsByFieldId,
    definitionsByName: definitionsByNameMutable,
    schemasByFieldId,
    seedsByKey,
    seedsByName: seedsByNameMutable,
  }
}
