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
  /** Membership `id`s claimed by more than one key-deduped seed this rebuild. The
   *  authoritative id-collision set (`materializeTypeSeeds`' `uncontestedTypeSeeds`
   *  recomputes the same thing for direct callers, but the SCHEDULED path filters
   *  against THIS so it can't miscount after `workspaceSeeds` drops a contested-key
   *  winner). Every seed carrying a contested id is withheld from materialization,
   *  same fail-closed stance as `contestedSeedKeys`. */
  readonly contestedTypeIds: ReadonlySet<string>
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

/** Reconstruct a block row's `TypeContribution` from its projected metadata +
 * resolved property schemas. Absent display fields are omitted (not stored as
 * `undefined`) so the result matches a hand-written `defineBlockType({…})`. `id`
 * defaults to the block id (user rows, whose membership id IS their block id) but
 * is overridden to the claimed membership id for a retired-seed row republished
 * under it (§7 resolution below). */
const contributionFromProjection = (
  def: ProjectedTypeDefinition,
  id: string = def.metadata.blockId,
): TypeContribution => {
  const m = def.metadata
  return {
    id,
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

/** Step 1 of the registry build, shared with the pre-pin unbound view: index the
 * declared seeds by key (keep-first), then synthesize each into its publishable
 * `typesById` contribution, deduping by membership id (keep-first, fail closed).
 * Also returns the contested key/id sets and the id→key map the projected-row
 * binding step needs. Pure over the declarations — no workspace or projected
 * rows required, which is exactly why the unbound view can reuse it. */
const synthesizeSeedTypes = (
  seeds: readonly TypeSeedDeclaration[],
): {
  seedsByKey: Map<string, TypeSeedDeclaration>
  contestedSeedKeys: Set<string>
  typesById: Map<string, TypeContribution>
  seedKeyById: Map<string, string>
  contestedTypeIds: Set<string>
} => {
  const {seedsByKey, contestedSeedKeys} = indexSeedsByKey(seeds)
  const typesById = new Map<string, TypeContribution>()
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
  return {seedsByKey, contestedSeedKeys, typesById, seedKeyById, contestedTypeIds}
}

/** Stage-0 type view used before a workspace is pinned: the declared seeds'
 * publishable contributions with no block binding (the type twin of
 * `buildUnboundPropertySchemas`). `getTypeBlockId` stays unavailable pre-pin —
 * that needs the workspace-scoped registry — but the code-owned seed types must
 * still surface in `repo.types` for a fresh client before any pin AND for the
 * window between runtime install and the first `setActiveWorkspaceId` (once a
 * runtime is installed, `repo._types` is driven by the facet rebuild, so the
 * static `KERNEL_TYPES` constructor fallback no longer applies). */
export const buildUnboundTypes = (
  seeds: readonly TypeSeedDeclaration[],
): ReadonlyMap<string, TypeContribution> => synthesizeSeedTypes(seeds).typesById

/** Build the workspace's type-definition registry from projected user rows +
 * declared seeds.
 *
 * Seeds are code-owned: the DECLARATION — not the materialized/synced block
 * mirror — is authoritative. So a declared seed is synthesized directly into
 * `typesById` (present on a fresh/read-only client before any row materializes,
 * and safe across a `typesFacet.of → seedType` conversion), and a projected row
 * that mirrors a declared seed contributes only its `blockId`/provenance, never
 * its (possibly stale/tampered) contribution or stored `block-type:type-id`
 * claim.
 *
 * A projected row whose `/type/` seed key is valid provenance (§4.2's id-equation
 * holds, checked upstream by `parseTypeDefinitionMetadata`) but is NOT a current
 * declaration is a RETIRED seed — most commonly a plugin's materialized type block
 * after the plugin's toggle was turned off, or a self-consistent forgery. Rather
 * than demote it to its backing-block uuid (which would SPLIT the type's identity:
 * blocks already tagged `todo` keep the string while the picker offers a rival uuid
 * id — see schema-unification §5.3 "definitions persist on disable"), it is
 * republished read-only under its CLAIMED membership id, so a disabled plugin's
 * type keeps resolving as `todo`. A LIVE declaration always outranks a retired row
 * for the same id; among competing retired rows for one undeclared id the earliest
 * `createdAt` wins (§7 winner-resolution, stable `blockId` tiebreak) — this is what
 * bounds §9's small-fleet forgery residual (an early real seed beats a late
 * forgery). Retired republication is scoped to the code-owned short-id namespace: a
 * genuine user row (no `/type/` seed key) publishes under its own block id (normally
 * a fresh uuid), and step 3 skips any id already published (`typesById.has`), so a
 * retired row can never overwrite a user row that happens to share its short id.
 *
 * Two seed-authoring/corruption hazards fail closed:
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
  // 1. Declared seeds — authoritative contribution, present even without a
  //    materialized row. Dedup by key then by membership id (fail closed).
  //    blockIdByTypeId is deferred to step 2, bound only from an actual valid
  //    mirror. Shared with `buildUnboundTypes` (the pre-pin view is step 1 alone).
  const {seedsByKey, contestedSeedKeys, typesById, seedKeyById, contestedTypeIds} =
    synthesizeSeedTypes(args.seeds)
  const definitionsByBlockId = new Map<string, TypeDefinitionMetadata>()
  const blockIdByTypeId = new Map<string, string>()
  // Retired-seed rows (valid `/type/` provenance, no live declaration), grouped by
  // claimed membership id and resolved after the loop by earliest-`createdAt`.
  const retiredByTypeId = new Map<string, ProjectedTypeDefinition[]>()

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

    if (def.metadata.seedKey !== undefined) {
      // Valid `/type/` seed provenance (the §4.2 id-equation held upstream) but
      // no live declaration: a RETIRED seed (disabled plugin) or a self-consistent
      // forgery. Defer to the post-loop earliest-`createdAt` resolution keyed by
      // the CLAIMED membership id — republishing under the real id keeps a disabled
      // plugin's type coherent instead of splitting it to a uuid.
      const group = retiredByTypeId.get(def.metadata.typeId)
      if (group) group.push(def)
      else retiredByTypeId.set(def.metadata.typeId, [def])
      continue
    }

    // A genuine user row (no `/type/` seed key): publish under its own block id — a
    // fresh uuid (`typeId === blockId`) that can never contend for a declared or
    // retired short id. The guard only fires for a pathological duplicate blockId.
    if (typesById.has(def.metadata.blockId)) continue
    typesById.set(def.metadata.blockId, contributionFromProjection(def))
    blockIdByTypeId.set(def.metadata.blockId, def.metadata.blockId)
  }

  // 3. Resolve retired-seed rows under their claimed id. Skip any id already
  //    published — by a live declaration (step 1, authoritative) OR a genuine user
  //    row (step 2): `typesById.has(typeId)` covers both, since a declared id is
  //    always in `typesById`. Retired resolution must never overwrite an existing
  //    entry (a user row whose block id is, abnormally, a short mnemonic string
  //    could otherwise be clobbered by a retired row claiming that same id). Among
  //    retired rows contending for one still-unclaimed id, earliest `createdAt`
  //    wins (stable `blockId` tiebreak): the §7 resolution bounding §9's forgery
  //    residual — an early real seed beats a late forgery. The winner republishes
  //    read-only; every row's `seedKey` provenance is already in
  //    `definitionsByBlockId` for the read-only gate.
  for (const [typeId, group] of retiredByTypeId) {
    if (typesById.has(typeId)) continue
    group.sort((a, b) =>
      a.metadata.createdAt !== b.metadata.createdAt
        ? a.metadata.createdAt - b.metadata.createdAt
        : a.metadata.blockId < b.metadata.blockId ? -1
          : a.metadata.blockId > b.metadata.blockId ? 1 : 0)
    const winner = group[0]!
    typesById.set(typeId, contributionFromProjection(winner, typeId))
    blockIdByTypeId.set(typeId, winner.metadata.blockId)
  }

  return {
    workspaceId: args.workspaceId,
    typesById,
    definitionsByBlockId,
    blockIdByTypeId,
    seedsByKey,
    contestedSeedKeys,
    contestedTypeIds,
  }
}
