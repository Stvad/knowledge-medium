import type {AnyPropertySchema, TypeContribution} from '@/data/api'
import type {TypeDefinitionMetadata} from '@/data/typeDefinitionMetadata'
import type {TypeSeedDeclaration} from '@/data/typeSeeds'

/** A block-built type entry kept beside its durable block identity. The public
 * types map is `typeId`-keyed (the membership token written into `typesProp`);
 * this internal form preserves the `blockId`→row link the §9 id-claim layer
 * needs — the type-side analog of `ProjectedPropertyDefinition`. The parser
 * (`parseTypeDefinitionMetadata`) supplies the codec-less identity/display
 * facts; `properties` carries the behavior it deliberately omits — the resolved
 * `block-type:properties` schemas, which only the stateful projector can
 * produce. */
export interface ProjectedTypeDefinition {
  readonly metadata: TypeDefinitionMetadata
  readonly properties: readonly AnyPropertySchema[]
}

/** The workspace-scoped type-definition registry — the id-keyed twin of
 * `PropertyDefinitionRegistrySnapshot`. `typesById` is the winner-resolved,
 * publishable contribution map; `definitionsByBlockId` retains every usable row
 * by its durable id (seed-provenance read-only gates + diagnostics);
 * `blockIdByTypeId` makes `getTypeBlockId` total for block-backed types. */
export interface TypeDefinitionRegistrySnapshot {
  readonly workspaceId: string
  readonly typesById: ReadonlyMap<string, TypeContribution>
  readonly definitionsByBlockId: ReadonlyMap<string, TypeDefinitionMetadata>
  readonly blockIdByTypeId: ReadonlyMap<string, string>
  readonly seedsByKey: ReadonlyMap<string, TypeSeedDeclaration>
  /** Seed keys contributed more than once this rebuild. The keep-first winner
   *  still publishes in-memory (see `indexSeedsByKey`), but a contested key must
   *  be withheld from MATERIALIZATION: its winner is contribution-order-dependent
   *  and the backing pass is create/restore-only, so persisting one would strand a
   *  stale mirror on a later reorder. `getTypeBlockId` stays undefined until the
   *  duplicate is resolved — the same fail-closed stance as a contested id. */
  readonly contestedSeedKeys: ReadonlySet<string>
}

export interface BuildTypeDefinitionRegistryArgs {
  readonly workspaceId: string
  /** Projected user block-type rows, keyed by block id (as the projector publishes). */
  readonly projectedDefinitions: ReadonlyMap<string, ProjectedTypeDefinition>
  readonly seeds: readonly TypeSeedDeclaration[]
}

/** A declared type seed IS a `TypeContribution` (its `id` is the membership
 * token) plus the `seedKey`/`revision` provenance keys. Rebuild the pure,
 * authoritative contribution without those two keys, so `typesById` holds clean
 * contributions (a downstream structural compare must not diverge on provenance
 * a bare `defineBlockType` never carries). */
const seedContribution = (seed: TypeSeedDeclaration): TypeContribution => ({
  id: seed.id,
  label: seed.label,
  ...(seed.description !== undefined ? {description: seed.description} : {}),
  ...(seed.color !== undefined ? {color: seed.color} : {}),
  ...(seed.hideFromCompletion !== undefined ? {hideFromCompletion: seed.hideFromCompletion} : {}),
  ...(seed.hideFromBlockDisplay !== undefined ? {hideFromBlockDisplay: seed.hideFromBlockDisplay} : {}),
  ...(seed.properties !== undefined ? {properties: seed.properties} : {}),
})

/** Reconstruct a user row's `TypeContribution` from its projected metadata +
 * resolved property schemas. Absent display fields are omitted (not stored as
 * `undefined`) so the result matches a hand-written `defineBlockType({…})`. */
const contributionFromProjection = (def: ProjectedTypeDefinition): TypeContribution => {
  const m = def.metadata
  return {
    id: m.blockId,
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
 * keep the first and warn rather than throw, because this runs on every facet
 * rebuild and one malformed dynamic contribution must not abort the pass. Every
 * key seen more than once is recorded in `contestedSeedKeys` so the materializer
 * can withhold it: the keep-first winner publishes in-memory (transient, rebuilt
 * each load) but must NOT become a create/restore-only backing row, whose winner
 * would be frozen contribution-order-dependent and stranded on a later reorder. */
const indexSeedsByKey = (
  seeds: readonly TypeSeedDeclaration[],
): {seedsByKey: Map<string, TypeSeedDeclaration>; contestedSeedKeys: Set<string>} => {
  const seedsByKey = new Map<string, TypeSeedDeclaration>()
  const contestedSeedKeys = new Set<string>()
  for (const seed of seeds) {
    if (seedsByKey.has(seed.seedKey)) {
      console.warn(
        `[buildTypeDefinitionRegistry] duplicate type seed key ${seed.seedKey}; ` +
        'keeping first (withheld from materialization until deduped)',
      )
      contestedSeedKeys.add(seed.seedKey)
      continue
    }
    seedsByKey.set(seed.seedKey, seed)
  }
  return {seedsByKey, contestedSeedKeys}
}

/** Build the workspace's type-definition registry from projected user rows +
 * declared seeds.
 *
 * Seeds are code-owned: the DECLARATION — not the materialized/synced block
 * mirror — is authoritative. So a declared seed is synthesized directly into
 * `typesById` (present on a fresh/read-only client before any row materializes,
 * and safe across a `typesFacet.of → seedType` conversion), and a projected row
 * that mirrors a declared seed contributes only its `blockId`/provenance, never
 * its (possibly stale/tampered) contribution or stored `block-type:type-id`
 * claim. A projected row whose `/type/` seed key is NOT a current declaration
 * (foreign / forged / retired) is refused and published under its own block id.
 *
 * Because seed backing blocks have deterministic ids (one per key) and user
 * rows carry fresh uuid ids (`typeId === blockId`), no two published entries
 * ever contend for one `typeId` — the §7 earliest-`createdAt` winner-resolution
 * the property registry needs for name collisions has no analog here once claims
 * are bound to declarations. Two seed-authoring/corruption hazards fail closed:
 * two seeds claiming one membership `id` (keep the first, warn — `typeSeedsFacet`
 * is a list so the collision stays observable rather than a silent last-wins
 * hijack), and binding a seed to a non-seed block — `blockIdByTypeId` is
 * populated ONLY from an actual valid mirror row (step 2), never predictively
 * from the deterministic id, since the pure registry can't prove that id is
 * unoccupied (a non-`block-type` or projector-dropped block there never appears
 * in `projectedDefinitions`). An unmaterialized seed is therefore
 * backing-block-less (`getTypeBlockId` → undefined until bootstrap materializes
 * it), never pointing a repair consumer at a possibly-poisoned row. */
export const buildTypeDefinitionRegistry = (
  args: BuildTypeDefinitionRegistryArgs,
): TypeDefinitionRegistrySnapshot => {
  const {seedsByKey, contestedSeedKeys} = indexSeedsByKey(args.seeds)
  const definitionsByBlockId = new Map<string, TypeDefinitionMetadata>()
  const typesById = new Map<string, TypeContribution>()
  const blockIdByTypeId = new Map<string, string>()

  // 1. Declared seeds — authoritative contribution, present even without a
  //    materialized row. Dedup by membership id (fail closed). blockIdByTypeId
  //    is deferred to step 2, bound only from an actual valid mirror.
  const seedKeyById = new Map<string, string>()
  const contestedTypeIds = new Set<string>()
  for (const seed of seedsByKey.values()) {
    const priorKey = seedKeyById.get(seed.id)
    if (priorKey !== undefined) {
      console.warn(
        `[buildTypeDefinitionRegistry] duplicate type seed id ${seed.id} ` +
        `(keys ${priorKey} + ${seed.seedKey}); keeping first`,
      )
      contestedTypeIds.add(seed.id)
      continue
    }
    seedKeyById.set(seed.id, seed.seedKey)
    typesById.set(seed.id, seedContribution(seed))
  }

  // 2. Projected block rows.
  for (const def of args.projectedDefinitions.values()) {
    if (def.metadata.workspaceId !== args.workspaceId) continue
    definitionsByBlockId.set(def.metadata.blockId, def.metadata)

    const declaredSeed = def.metadata.seedKey !== undefined
      ? seedsByKey.get(def.metadata.seedKey)
      : undefined
    if (declaredSeed) {
      // A mirror of a declared seed — code-owned. If it backs the ACTIVE seed
      // for that id, bind the declared id to this block's location (the declared
      // contribution from step 1 stays authoritative). If the seed is INACTIVE
      // (it lost the membership-id dedup to another seed), the mirror is still
      // code-owned: retain it only in `definitionsByBlockId` (above) for
      // provenance — never republish it as a user-selectable type.
      //
      // Refuse the binding when the seed's key OR id is CONTESTED (duplicated
      // this rebuild). The materializer withholds contested seeds from NEW writes,
      // but it can't delete a row created while the seed was uncontested — so an
      // already-materialized mirror survives a later collision. Its stored content
      // is frozen contribution-order-dependent (which duplicate first materialized),
      // so keep `getTypeBlockId` UNDEFINED until the collision is resolved rather
      // than pointing a link/repair consumer at that stale, order-dependent block.
      if (
        seedKeyById.get(declaredSeed.id) === declaredSeed.seedKey &&
        !contestedSeedKeys.has(declaredSeed.seedKey) &&
        !contestedTypeIds.has(declaredSeed.id)
      ) {
        blockIdByTypeId.set(declaredSeed.id, def.metadata.blockId)
      }
      continue
    }

    // A user row (seed key absent, or a `/type/` key that isn't a current
    // declaration — foreign/forged/retired): publish under its own block id,
    // never a stored claim. A declared seed already owning this id always wins
    // (a user block id is a fresh uuid, so this guard only fires for a
    // pathological forged/duplicate id).
    if (typesById.has(def.metadata.blockId)) continue
    typesById.set(def.metadata.blockId, contributionFromProjection(def))
    blockIdByTypeId.set(def.metadata.blockId, def.metadata.blockId)
  }

  return {
    workspaceId: args.workspaceId,
    typesById,
    definitionsByBlockId,
    blockIdByTypeId,
    seedsByKey,
    contestedSeedKeys,
  }
}
