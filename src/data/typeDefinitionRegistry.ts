import type {AnyPropertySchema, TypeContribution} from '@/data/api'
import type {TypeDefinitionMetadata} from '@/data/typeDefinitionMetadata'
import type {TypeSeedDeclaration} from '@/data/typeSeeds'
import {isPropertySeedDeclaration, type AnyPropertySeedDeclaration} from '@/data/propertySeeds'
import {propertySeedKeyOf, seedKeyOwner, typeSeedKeyOutranks} from '@/data/definitionSeeds'

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
  /** Each membership `id` → the seed key that WON it. A membership id claimed by
   *  more than one key-deduped seed (two installs of the same dynamic extension, or
   *  two plugins colliding) resolves via `typeSeedKeyOutranks`: a built-in (`system:`)
   *  seed beats a third-party extension trying to take over a built-in id, otherwise
   *  the LOWEST seed key wins — a deterministic, contribution-order-INDEPENDENT winner, so the
   *  choice is stable across reloads and only ONE backing block is materialized per
   *  id. This replaces the
   *  earlier fail-closed stance (which withheld every contender): an id clash now
   *  degrades gracefully to one working type. The loser never materializes; a former
   *  winner demoted by an install change becomes a retired row (§7). This is the
   *  authoritative winner map — `materializingTypeSeeds` / `workspaceSeeds`
   *  materialize exactly its winners, `materializeTypeSeeds`' scheduled recheck
   *  gates on it, and step 2's block-id binding uses it. */
  readonly seedKeyById: ReadonlyMap<string, string>
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
 * `typesById` contribution, resolving a membership-id collision via
 * `typeSeedKeyOutranks` (a built-in `system:` seed beats a third-party hijack, else
 * the lowest seed key). That winner is deterministic and contribution-order-
 * independent, so a two-install / two-plugin id clash degrades gracefully to one
 * stable working type (rather than failing closed and stranding both) and the
 * single materialized backing block never flips on a reorder. Returns the
 * contested-key set and the id→winning-key map (`seedKeyById`) the projected-row
 * binding + materialization paths need. Pure over the declarations — no workspace
 * or projected rows required, which is exactly why the unbound view can reuse it. */
const synthesizeSeedTypes = (
  seeds: readonly TypeSeedDeclaration[],
): {
  seedsByKey: Map<string, TypeSeedDeclaration>
  contestedSeedKeys: Set<string>
  typesById: Map<string, TypeContribution>
  seedKeyById: Map<string, string>
} => {
  const {seedsByKey, contestedSeedKeys} = indexSeedsByKey(seeds)
  const typesById = new Map<string, TypeContribution>()
  const seedKeyById = new Map<string, string>()
  const warnedIds = new Set<string>()
  for (const seed of seedsByKey.values()) {
    const priorKey = seedKeyById.get(seed.id)
    if (priorKey === undefined) {
      seedKeyById.set(seed.id, seed.seedKey)
      typesById.set(seed.id, seedContribution(seed))
      continue
    }
    // Same membership id claimed by another key. Winner-resolve (`typeSeedKeyOutranks`
    // — a built-in `system:` seed beats a third-party hijack, else the lowest seed key
    // wins) rather than fail closed. The winner is order-independent, so it (and the one
    // materialized backing block) is stable across reloads, unlike a keep-first pick.
    // Warn once per id: a genuine two-plugin collision is worth surfacing, and for the
    // expected two-install case it's one benign line — mirroring the property side,
    // which already logs per rebuild when two installs collide on a property name.
    if (!warnedIds.has(seed.id)) {
      console.warn(
        `[buildTypeDefinitionRegistry] membership id ${JSON.stringify(seed.id)} is claimed by ` +
        'multiple type seeds; resolving to the highest-priority (built-in first, else lowest seed key)',
      )
      warnedIds.add(seed.id)
    }
    if (typeSeedKeyOutranks(seed.seedKey, priorKey)) {
      seedKeyById.set(seed.id, seed.seedKey)
      typesById.set(seed.id, seedContribution(seed))
    }
  }
  return {seedsByKey, contestedSeedKeys, typesById, seedKeyById}
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
 * A membership-`id` collision (two key-deduped seeds claiming one `id`) is
 * WINNER-RESOLVED, not fail-closed: a built-in (`system:`) seed outranks a third-party
 * hijack, otherwise the lowest seed key wins (deterministic, order-independent — see
 * `typeSeedKeyOutranks`), so a two-install / two-plugin clash degrades to one working
 * type and one stable backing block; a warn keeps the collision observable. Only the
 * true authoring/corruption hazard still fails closed — binding a seed to a non-seed
 * block — where `blockIdByTypeId` is
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
  const {seedsByKey, contestedSeedKeys, typesById, seedKeyById} =
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
      // Bind only the id-WINNER's mirror. `seedKeyById.get(id) === seedKey` is
      // exactly the winner test (an id-loser's key is never the winning key), so a
      // membership-id collision binds the lowest-seed-key winner's block and leaves
      // the losers' mirrors provenance-only — `getTypeBlockId` resolves the one
      // stable winner instead of failing closed. A contested KEY still refuses:
      // its keep-first winner is order-dependent and the materializer can't delete a
      // row created while it was uncontested, so pointing a link/repair consumer at
      // that stale block is unsafe until the duplicate key is removed.
      if (
        seedKeyById.get(declaredSeed.id) === declaredSeed.seedKey &&
        !contestedSeedKeys.has(declaredSeed.seedKey)
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
    seedKeyById,
  }
}

/** The winning, materializable type seeds — one per membership id (the
 * lowest-seed-key winner from `seedKeyById`) whose key is not itself contested.
 * This is the set that earns a backing block: `workspaceSeeds` materializes exactly
 * these, and nested-property auto-contribution harvests only from these (a loser
 * install's nested property would orphan — its type never materializes to reference
 * it). Derived purely from the snapshot, so callers agree with what the registry
 * published and bound. */
export const materializingTypeSeeds = (
  snapshot: TypeDefinitionRegistrySnapshot,
): readonly TypeSeedDeclaration[] => {
  const winners: TypeSeedDeclaration[] = []
  for (const winningKey of snapshot.seedKeyById.values()) {
    if (snapshot.contestedSeedKeys.has(winningKey)) continue
    const seed = snapshot.seedsByKey.get(winningKey)
    if (seed) winners.push(seed)
  }
  return winners
}

/** Property seeds embedded in materializing type seeds' `properties` that the
 * author did NOT contribute separately — auto-contributed so an inline-only
 * property still materializes a backing block (otherwise its
 * `block-type:properties` ref, written by `canonicalTypeSeedProperties`, dangles).
 * A type's `properties` thus becomes a materialization source for the properties it
 * OWNS, closing the "embed a property but forget to seed it" footgun without any
 * extra author boilerplate. Deliberately scoped:
 *   - only FULL property-seed declarations (a bare `{seedKey}` ref/stub carries no
 *     preset/codec, so nothing to materialize) — an own-owned stub that nothing
 *     else provides is warned, since its ref will dangle;
 *   - only OWN-owned (the property's owner matches the type's): a type must not
 *     materialize another owner's property, so a cross-owner reference stays a pure
 *     ref, resolved if/when its real owner contributes it;
 *   - deduped by seed key, and only KEYS not already explicitly contributed
 *     (explicit wins — else `buildPropertyDefinitionRegistry`'s duplicate-key guard
 *     throws, e.g. the `todo` pattern that both embeds AND separately seeds
 *     `statusProp`). A CONFLICTING duplicate (same key, a DIFFERENT declaration) is
 *     kept-first and warned — only the provider's payload materializes, so the loser
 *     would otherwise silently advertise a name/codec its durable block lacks.
 * Only winning type seeds are scanned (`materializingTypeSeeds`), so a loser
 * install's nested property is never harvested. The returned seeds are appended to
 * the `definitionSeedsFacet` set before the property registry is built, so they
 * flow into schema resolution AND materialization by the same path as any seed. */
export const harvestNestedPropertySeeds = (
  snapshot: TypeDefinitionRegistrySnapshot,
  explicitPropertySeeds: readonly AnyPropertySeedDeclaration[],
): readonly AnyPropertySeedDeclaration[] => {
  // `providedByKey` tracks the ONE declaration each key resolves to (explicit wins,
  // else the first harvested winner) — the object whose payload the deterministic
  // property block actually materializes from.
  const providedByKey = new Map<string, AnyPropertySeedDeclaration>()
  for (const seed of explicitPropertySeeds) providedByKey.set(seed.seedKey, seed)
  const harvested: AnyPropertySeedDeclaration[] = []
  // Own-owned STUB refs (valid `/property/` key, not a full declaration). Warned
  // AFTER the full sweep and only if nothing ever provides the key — so a stub that a
  // full declaration for the same key (any type, any order) does provide never
  // false-warns. Keyed by property key to dedupe the warning.
  const stubRefTypeByKey = new Map<string, string>()
  for (const typeSeed of materializingTypeSeeds(snapshot)) {
    if (typeSeed.properties === undefined) continue
    const typeOwner = seedKeyOwner(typeSeed.seedKey)
    for (const prop of typeSeed.properties) {
      const key = propertySeedKeyOf(prop)
      if (key === undefined) continue // not a `/property/` ref at all
      if (seedKeyOwner(key) !== typeOwner) continue // cross-owner → pure ref, leave it
      if (!isPropertySeedDeclaration(prop)) {
        stubRefTypeByKey.set(key, typeSeed.seedKey)
        continue
      }
      const provider = providedByKey.get(key)
      if (provider === undefined) {
        providedByKey.set(key, prop)
        harvested.push(prop)
      } else if (provider !== prop) {
        // The key is already provided by a DIFFERENT declaration (an explicit seed or
        // an earlier winner). Only the provider's payload materializes into the shared
        // deterministic block, so this later declaration would advertise a name/codec
        // its durable definition doesn't carry. The property registry rejects a
        // duplicate key outright; harvest can't throw (one bad contribution mustn't
        // abort the whole property registry), so keep the provider and surface the
        // conflict. (An IDENTICAL object — the `todo` embed+seed pattern — is silent.)
        console.warn(
          `[harvestNestedPropertySeeds] type seed ${JSON.stringify(typeSeed.seedKey)} inlines property ` +
          `${JSON.stringify(key)} that is already declared elsewhere; keeping the first declaration ` +
          '(its durable definition is what the block materializes)',
        )
      }
    }
  }
  for (const [key, typeSeedKey] of stubRefTypeByKey) {
    if (providedByKey.has(key)) continue // a full declaration provides it after all
    console.warn(
      `[harvestNestedPropertySeeds] type seed ${JSON.stringify(typeSeedKey)} references ` +
      `its own property ${JSON.stringify(key)} that is neither a full property-seed declaration ` +
      'nor contributed separately; its block-type:properties ref will dangle until it is seeded',
    )
  }
  return harvested
}
