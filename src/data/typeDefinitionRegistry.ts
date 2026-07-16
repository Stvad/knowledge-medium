import type {AnyPropertySchema, TypeContribution} from '@/data/api'
import type {TypeDefinitionMetadata} from '@/data/typeDefinitionMetadata'
import type {TypeSeedDeclaration} from '@/data/typeSeeds'

/** A block-built type entry kept beside its durable block identity. The public
 * types map is `typeId`-keyed (the membership token written into `typesProp`);
 * this internal form preserves the `blockId`→row link the §9 id-claim /
 * winner-resolution layer needs — the type-side analog of
 * `ProjectedPropertyDefinition`. The parser (`parseTypeDefinitionMetadata`)
 * supplies the codec-less identity/display facts; `properties` carries the
 * behavior it deliberately omits — the resolved `block-type:properties`
 * schemas, which only the stateful projector can produce. */
export interface ProjectedTypeDefinition {
  readonly metadata: TypeDefinitionMetadata
  readonly properties: readonly AnyPropertySchema[]
}

/** The workspace-scoped type-definition registry — the id-keyed twin of
 * `PropertyDefinitionRegistrySnapshot`. `typesById` is the winner-resolved,
 * publishable contribution map; `definitionsByBlockId` retains every usable
 * row by its durable id (seed-provenance read-only gates + diagnostics);
 * `blockIdByTypeId` makes `getTypeBlockId` total for block-backed types. */
export interface TypeDefinitionRegistrySnapshot {
  readonly workspaceId: string
  readonly typesById: ReadonlyMap<string, TypeContribution>
  readonly definitionsByBlockId: ReadonlyMap<string, TypeDefinitionMetadata>
  readonly blockIdByTypeId: ReadonlyMap<string, string>
  readonly seedsByKey: ReadonlyMap<string, TypeSeedDeclaration>
}

export interface BuildTypeDefinitionRegistryArgs {
  readonly workspaceId: string
  /** Projected user block-type rows, keyed by block id (as the projector publishes). */
  readonly projectedDefinitions: ReadonlyMap<string, ProjectedTypeDefinition>
  readonly seeds: readonly TypeSeedDeclaration[]
}

/** Reconstruct the publishable `TypeContribution` from a projected row: the
 * parser's identity/display facts + the projector's resolved property schemas.
 * Absent display fields are omitted (not stored as `undefined`) so the result
 * matches a hand-written `defineBlockType({…})` for the same fields. */
const contributionFromProjection = (def: ProjectedTypeDefinition): TypeContribution => {
  const m = def.metadata
  return {
    id: m.typeId,
    label: m.label,
    ...(m.description ? {description: m.description} : {}),
    ...(m.hideFromBlockDisplay ? {hideFromBlockDisplay: m.hideFromBlockDisplay} : {}),
    ...(m.hideFromCompletion ? {hideFromCompletion: m.hideFromCompletion} : {}),
    ...(m.color ? {color: m.color} : {}),
    properties: def.properties,
  }
}

/** Index the declared type seeds by key. Duplicate keys are a code-owned
 * invariant violation (the deterministic-id namespace assumes unique keys); we
 * keep the first and warn rather than throw, because this runs on every
 * facet rebuild and one malformed dynamic contribution must not abort the pass. */
const indexSeedsByKey = (
  seeds: readonly TypeSeedDeclaration[],
): ReadonlyMap<string, TypeSeedDeclaration> => {
  const byKey = new Map<string, TypeSeedDeclaration>()
  for (const seed of seeds) {
    if (byKey.has(seed.seedKey)) {
      console.warn(`[buildTypeDefinitionRegistry] duplicate type seed key ${seed.seedKey}; keeping first`)
      continue
    }
    byKey.set(seed.seedKey, seed)
  }
  return byKey
}

/** Build the workspace's type-definition registry from projected user rows +
 * declared seeds.
 *
 * §9 type-id claim / §7 winner resolution: `parseTypeDefinitionMetadata` has
 * already resolved each row's effective `typeId` (a differing
 * `block-type:type-id` claim is honored only for a self-consistent `/type/`
 * seed row, else demoted to the block id). Two rows can therefore land on the
 * same `typeId` only via that claim (a real seed + an imported/forged
 * competitor, or two workspaces' materialized copies). We bound that here with
 * the same rule the property registry uses for name collisions: the earliest
 * `createdAt` wins (stable `blockId` tiebreak), so the early real seed beats a
 * late import. Bare last-wins (today's `typesFacet`) is NOT acceptable — it
 * lets a late forgery win nondeterministically.
 *
 * NOTE (§9 residual, per flags-for-user): this is the *as-written* stance —
 * winner-resolution only. It does not additionally reject a claim whose key is
 * absent from `seeds` (a forged `/type/` key with a real deterministic id); the
 * declared-seed set is carried in `seedsByKey` so a future tightening can gate
 * on it without a shape change. */
export const buildTypeDefinitionRegistry = (
  args: BuildTypeDefinitionRegistryArgs,
): TypeDefinitionRegistrySnapshot => {
  const seedsByKey = indexSeedsByKey(args.seeds)
  const definitionsByBlockId = new Map<string, TypeDefinitionMetadata>()
  const claimantsByTypeId = new Map<string, ProjectedTypeDefinition[]>()

  for (const def of args.projectedDefinitions.values()) {
    if (def.metadata.workspaceId !== args.workspaceId) continue
    definitionsByBlockId.set(def.metadata.blockId, def.metadata)
    const bucket = claimantsByTypeId.get(def.metadata.typeId)
    if (bucket) bucket.push(def)
    else claimantsByTypeId.set(def.metadata.typeId, [def])
  }

  const typesById = new Map<string, TypeContribution>()
  const blockIdByTypeId = new Map<string, string>()
  for (const [typeId, claimants] of claimantsByTypeId) {
    // Earliest createdAt wins; blockId is the deterministic tiebreak (never
    // insertion order — that would be nondeterministic across rebuilds).
    claimants.sort((a, b) => {
      if (a.metadata.createdAt !== b.metadata.createdAt) {
        return a.metadata.createdAt - b.metadata.createdAt
      }
      return a.metadata.blockId < b.metadata.blockId
        ? -1
        : a.metadata.blockId > b.metadata.blockId
          ? 1
          : 0
    })
    const winner = claimants[0]!
    typesById.set(typeId, contributionFromProjection(winner))
    blockIdByTypeId.set(typeId, winner.metadata.blockId)
  }

  return {
    workspaceId: args.workspaceId,
    typesById,
    definitionsByBlockId,
    blockIdByTypeId,
    seedsByKey,
  }
}
