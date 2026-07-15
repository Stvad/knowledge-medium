import type {
  AnyPropertyEditorOverride,
  AnyPropertySchema,
} from '@/data/api'
import {propertyDefinitionBlockId} from '@/data/definitionSeeds'
import type {PropertyDefinitionMetadata} from '@/data/propertyDefinitionMetadata'
import {isPropertySeedDeclaration, type AnyPropertySeedDeclaration} from '@/data/propertySeeds'

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
  /** Transitional type-lifted schemas (`TypeContribution.properties`). The
   *  direct-registration source was removed in B′; the type-lift dies at the
   *  types cutover (Slice C). */
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
    // v1 no-shadowing: property values are keyed by name, so two seeds sharing a
    // name is an inherent conflict (they would fight over one stored cell). Keep
    // the first and DROP the collider — loudly, so a plugin author notices and
    // namespaces (e.g. "myplugin:title"). We drop rather than throw: this runs on
    // every workspace registry rebuild, and the dynamic-extension loader keeps
    // the declared name while rewriting only the seedKey per block, so a
    // duplicate install (or two extensions colliding) must not crash the whole
    // workspace's schema registry.
    const existing = byName.get(seed.name)
    if (existing) {
      console.error(
        `[property definitions] dropping seed ${JSON.stringify(seed.seedKey)}: its name ` +
        `${JSON.stringify(seed.name)} collides with ${JSON.stringify(existing[0]!.seedKey)}; ` +
        `property names must be unique — namespace plugin seeds, e.g. "myplugin:name"`,
      )
      continue
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
  const {byKey: seedsByKey, byName: seedsByDeclarationName} = indexSeeds(args.seeds)
  const definitionsByFieldId = new Map<string, PropertyDefinitionMetadata>()
  const definitionsByNameMutable = new Map<string, PropertyDefinitionMetadata[]>()
  const schemasByFieldId = new Map<string, AnyPropertySchema>()
  for (const projected of args.projectedDefinitions.values()) {
    const raw = projected.metadata
    if (raw.workspaceId !== args.workspaceId) continue
    // Seeds are code-owned and non-renamable (user renames are deferred to
    // #288): a seed-provenanced row's effective name is always its declared
    // name. Normalizing here means a stored property-schema:name divergence
    // (an older client, an import, or a sync from such a device) cannot desync
    // the structural type/alias membership index or drop the field from a
    // static type's panel section.
    const declared = raw.seedKey ? seedsByKey.get(raw.seedKey) : undefined
    const definition = declared && declared.name !== raw.name ? {...raw, name: declared.name} : raw
    definitionsByFieldId.set(definition.fieldId, definition)
    if (projected.schema) schemasByFieldId.set(definition.fieldId, projected.schema)
    // v1: code-owned seeds are unshadowable. A row competes for its name only if
    // it is a CURRENT seed's own row (its seedKey is still declared/kept) or a
    // non-seed row whose name doesn't collide with a kept seed's declared name.
    // Two exclusions fall out of this:
    //   - a non-seed (user/imported) collider: the seed always wins the name, so
    //     `resolve`/`resolveName` never resolve `shadowed` and structural fields
    //     like `types` stay on the seed even when an older same-name block
    //     predates it;
    //   - a DROPPED duplicate seed's already-materialized row: `indexSeeds` keeps
    //     only the first of two same-name seeds, so the loser's seedKey is absent
    //     from `seedsByKey`. Gating on `seedsByKey.has` (not merely `seedKey`)
    //     stops that persisted row from out-sorting the kept seed by an earlier
    //     createdAt and publishing its behavior — otherwise the collider wouldn't
    //     actually be dropped.
    // Either way the excluded block still lives in `definitionsByFieldId`
    // (resolvable by field id, itself shadowed BY the seed); its stored values are
    // read under the seed's codec (a codec-incompatible leftover surfaces loudly).
    const isCurrentSeedRow = definition.seedKey !== undefined && seedsByKey.has(definition.seedKey)
    if (isCurrentSeedRow || !seedsByDeclarationName.has(definition.name)) {
      pushGrouped(definitionsByNameMutable, definition.name, definition)
    }
  }
  for (const definitions of definitionsByNameMutable.values()) {
    definitions.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
      return a.fieldId < b.fieldId ? -1 : a.fieldId > b.fieldId ? 1 : 0
    })
  }

  const seedsByNameMutable = new Map<string, AnyPropertySeedDeclaration[]>()
  for (const seed of seedsByKey.values()) {
    const fieldId = propertyDefinitionBlockId(args.workspaceId, seed.seedKey)
    const definition = definitionsByFieldId.get(fieldId)
    // A deterministic-id occupant with different provenance invalidates this
    // declaration for the workspace; it must not participate in name fallback.
    if (definition && definition.seedKey !== seed.seedKey) continue
    pushGrouped(seedsByNameMutable, definition?.name ?? seed.name, seed)
  }

  const schemas = new Map(args.legacySchemas)
  // Declarations own their original names even after synced metadata renames
  // them. Clear transitional behavior under both declaration and effective
  // names before selected winners repopulate the ambient map.
  for (const name of seedsByDeclarationName.keys()) schemas.delete(name)
  for (const [name, definitions] of definitionsByNameMutable) {
    const winnerSchema = schemasByFieldId.get(definitions[0]!.fieldId)
    if (!winnerSchema) {
      schemas.delete(name)
      continue
    }
    schemas.set(name, name === winnerSchema.name
      ? winnerSchema
      : {...winnerSchema, name})
  }
  for (const [name, namedSeeds] of seedsByNameMutable) {
    const winner = definitionsByNameMutable.get(name)?.[0]
    const seed = winner
      ? namedSeeds.find(candidate =>
        propertyDefinitionBlockId(args.workspaceId, candidate.seedKey) === winner.fieldId)
      : namedSeeds.length === 1 ? namedSeeds[0] : undefined
    // With synced state, publish only its selected deterministic declaration.
    // With zero rows, a unique effective name is required; contribution order
    // never selects between ambiguous declarations.
    if (!seed) continue
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

/** The seed identity a property name resolves to for the editor-override join
 * (B′ §8). Mirrors the winner→ambiguous-seed→stage-0 resolution the panel's
 * hidden-flag join uses:
 *   - a winning definition carries the answer (its `seedKey`, or none for a
 *     user row → no override);
 *   - before a workspace is pinned (or a snapshot briefly lagging a swap), the
 *     ambient schema entry may itself be the seed declaration. */
const resolveSeedKeyForName = (
  name: string,
  definitions: PropertyDefinitionRegistrySnapshot | null,
  schema: AnyPropertySchema | undefined,
): string | undefined => {
  if (definitions) {
    const winner = definitions.definitionsByName.get(name)?.[0]
    if (winner) return winner.seedKey
    // No winner yet: only an unambiguous single seed declaration names it.
    const seeds = definitions.seedsByName.get(name)
    if (seeds !== undefined) return seeds.length === 1 ? seeds[0]!.seedKey : undefined
  }
  return schema !== undefined && isPropertySeedDeclaration(schema)
    ? schema.seedKey
    : undefined
}

/** Resolve the editor override for a property name by joining through seed
 * identity (B′ §8): the name's winning definition (or ambient seed
 * declaration) yields a `seedKey` that keys the seedKey-keyed override map.
 * Returns undefined when the name has no seed identity — user-authored rows
 * carry no override. Replaces the former name-key `uis.get(name)` join. */
export const resolveEditorOverride = (
  name: string,
  definitions: PropertyDefinitionRegistrySnapshot | null,
  overridesBySeedKey: ReadonlyMap<string, AnyPropertyEditorOverride>,
  schema: AnyPropertySchema | undefined,
): AnyPropertyEditorOverride | undefined => {
  const seedKey = resolveSeedKeyForName(name, definitions, schema)
  return seedKey === undefined ? undefined : overridesBySeedKey.get(seedKey)
}
