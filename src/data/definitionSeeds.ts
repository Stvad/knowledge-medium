import {v5 as uuidv5} from 'uuid'
import {ChangeScope, type BlockData} from '@/data/api'
import {isPropertySeedKey, type AnyPropertySeedDeclaration} from '@/data/propertySeeds'
import {isTypeSeedKey, type TypeSeedDeclaration} from '@/data/typeSeeds'
import {
  blockTypeColorProp,
  blockTypeDescriptionProp,
  blockTypeHideFromBlockDisplayProp,
  blockTypeHideFromCompletionProp,
  blockTypeLabelProp,
  blockTypePropertiesProp,
  blockTypeTypeIdProp,
  presetConfigProp,
  presetIdProp,
  propertyChangeScopeProp,
  propertyDefaultProp,
  propertyHiddenProp,
  propertyNameProp,
  seedKeyProp,
  seedRevisionProp,
  addBlockTypeToProperties,
} from '@/data/properties'
import {BLOCK_TYPE_TYPE, PROPERTY_SCHEMA_TYPE} from '@/data/blockTypes'
import {propertiesPageBlockId, getOrCreatePropertiesPage} from '@/data/propertiesPage'
import {typesPageBlockId, getOrCreateTypesPage} from '@/data/typesPage'
import type {Repo} from '@/data/repo'
import {awaitLocalMemberRole} from '@/data/workspaces'

/** Namespace for every deterministic code-owned definition block — property
 * AND type seeds. Identity is always workspace-scoped:
 * uuidv5(`${workspaceId}:${seedKey}`, namespace). Property (`/property/`) and
 * type (`/type/`) seed keys share this namespace safely: their key grammars are
 * disjoint, so `${workspaceId}:${seedKey}` can never collide across kinds — and
 * the two public id functions below ENFORCE that grammar (throwing on a
 * wrong-kind key) so the disjointness is a checked invariant, not just a
 * convention a caller could break by passing the wrong-kind key to the wrong
 * function. (The non-collision proof also assumes `workspaceId` never contains
 * `:`, so the delimiter can't shift between the two interpolated fields — true
 * for the UUID workspace ids this codebase mints.) */
export const DEFINITION_SEED_NS = '737c2e9d-f3e9-4c99-94ef-e1cbec920e30'

/** The raw deterministic formula, shared by both kinds. Private and unguarded:
 * the grammar checks live in the two public entry points so there is exactly one
 * hash expression to keep in sync. */
const definitionBlockId = (workspaceId: string, seedKey: string): string =>
  uuidv5(`${workspaceId}:${seedKey}`, DEFINITION_SEED_NS)

export const propertyDefinitionBlockId = (workspaceId: string, seedKey: string): string => {
  if (!isPropertySeedKey(seedKey)) {
    throw new Error(`[propertyDefinitionBlockId] not a property seed key: ${JSON.stringify(seedKey)}`)
  }
  return definitionBlockId(workspaceId, seedKey)
}

/** Deterministic per-workspace backing-block id for a code-owned block type.
 * The type analog of `propertyDefinitionBlockId`; this is what a total
 * `getTypeBlockId` returns for a code type (Slice C). */
export const typeDefinitionBlockId = (workspaceId: string, seedKey: string): string => {
  if (!isTypeSeedKey(seedKey)) {
    throw new Error(`[typeDefinitionBlockId] not a type seed key: ${JSON.stringify(seedKey)}`)
  }
  return definitionBlockId(workspaceId, seedKey)
}

/** Owner segment of a code-owned seed key — everything before the FIRST `/`.
 * Grammar-agnostic across BOTH kinds (`<owner>/property/<key>` and
 * `<owner>/type/<key>`, where an owner never contains `/`), unlike
 * `propertySchemaOriginForSeedKey`, which assumes the `/property/` segment and
 * silently truncates a `/type/` owner (the split `typeDefinitionMetadata` flagged
 * as needed). Used to gate nested-property auto-contribution to a type's OWN owner:
 * a type materializes only the properties it owns, never another owner's. */
export const seedKeyOwner = (seedKey: string): string => {
  const slash = seedKey.indexOf('/')
  return slash === -1 ? seedKey : seedKey.slice(0, slash)
}

const KERNEL_SEED_OWNER = 'system:kernel-data'

/** Winner comparator for two type seeds that claim ONE membership id (compares
 * their seed keys). A kernel-owned seed (`system:kernel-data`) always outranks a
 * non-kernel one, so an installed plugin/extension can never take over a built-in
 * id (the anti-hijack invariant the old fail-closed stance protected). Among
 * same-privilege seeds the lexicographically-LOWER key wins — deterministic and
 * contribution-order-INDEPENDENT, so two installs of one extension resolve to a
 * single stable winner (and one stable backing block) instead of flipping with load
 * order. Returns true when `challenger` should replace the current winner
 * `incumbent`. Shared by the registry (`synthesizeSeedTypes`) and the direct-caller
 * materialization filter (`winnerTypeSeeds`) so both pick the same winner. */
export const typeSeedKeyOutranks = (challenger: string, incumbent: string): boolean => {
  const challengerKernel = seedKeyOwner(challenger) === KERNEL_SEED_OWNER
  const incumbentKernel = seedKeyOwner(incumbent) === KERNEL_SEED_OWNER
  if (challengerKernel !== incumbentKernel) return challengerKernel
  return challenger < incumbent
}

type SeedIdentityRow = Pick<BlockData, 'id' | 'workspaceId' | 'properties'>

const validSeedKeyForRow = (row: SeedIdentityRow): string | undefined => {
  const rawSeedKey = row.properties[seedKeyProp.name]
  let seedKey: string
  try {
    seedKey = seedKeyProp.codec.decode(rawSeedKey)
  } catch {
    return undefined
  }
  // Code-seeded under EITHER grammar (property or type). Both kinds hash the
  // same formula into one shared namespace, so a matching deterministic id for
  // the row's own workspace is the proof; a key of neither grammar isn't seeded.
  if (!isPropertySeedKey(seedKey) && !isTypeSeedKey(seedKey)) return undefined
  return row.id === definitionBlockId(row.workspaceId, seedKey) ? seedKey : undefined
}

/** A seed:key property alone proves nothing. A row is code-seeded only when
 * the key has property- OR type-declaration grammar and its id satisfies the
 * deterministic equation for that row's own workspace. `seededDefinitionKey`
 * returns that validated key so a caller can distinguish PROPERTY from TYPE
 * provenance by its grammar (`isPropertySeedKey`/`isTypeSeedKey`);
 * `isValidSeededDefinition` is the boolean form. */
export const seededDefinitionKey = (row: SeedIdentityRow): string | undefined =>
  validSeedKeyForRow(row)

export const isValidSeededDefinition = (row: SeedIdentityRow): boolean =>
  seededDefinitionKey(row) !== undefined

/** The one canonical block-property bag for a property seed. All values pass
 * through their metadata schema codecs; a per-schema default key is omitted
 * unless the declaration explicitly supplied one. */
export const canonicalPropertySeedProperties = (
  seed: AnyPropertySeedDeclaration,
): Record<string, unknown> => {
  const properties: Record<string, unknown> = {
    [propertyNameProp.name]: propertyNameProp.codec.encode(seed.name),
    [presetIdProp.name]: presetIdProp.codec.encode(seed.presetId),
    [presetConfigProp.name]: presetConfigProp.codec.encode(
      seed.encodedConfig as Record<string, unknown>,
    ),
    [propertyChangeScopeProp.name]: propertyChangeScopeProp.codec.encode(seed.changeScope),
    [propertyHiddenProp.name]: propertyHiddenProp.codec.encode(seed.hidden),
    [seedKeyProp.name]: seedKeyProp.codec.encode(seed.seedKey),
    [seedRevisionProp.name]: seedRevisionProp.codec.encode(seed.revision),
  }
  if (seed.hasExplicitDefault) {
    properties[propertyDefaultProp.name] = propertyDefaultProp.codec.encode(seed.encodedDefaultValue)
  }
  return addBlockTypeToProperties(properties, PROPERTY_SCHEMA_TYPE)
}

/** Extract a property's `/property/` seed key, or undefined when it has none — a
 * non-seed property (a bare `defineProperty` handle carries no seed key), or a
 * malformed dynamic contribution whose `properties` array holds a NON-OBJECT
 * entry. `isTypeSeedDeclaration` rejects non-record elements at the FACET
 * boundary, but `materializeTypeSeeds` / `canonicalTypeSeedProperties` also take
 * explicit unvalidated arrays from direct callers that never pass through it, so
 * guarding object-ness before the `in` check is still load-bearing: it keeps one
 * bad entry (a primitive/null) from THROWING and aborting the whole workspace's
 * type materialization pass — skip+warn it instead. */
export const propertySeedKeyOf = (prop: unknown): string | undefined => {
  if (typeof prop !== 'object' || prop === null || !('seedKey' in prop)) return undefined
  const key: unknown = (prop as {readonly seedKey: unknown}).seedKey
  return isPropertySeedKey(key) ? key : undefined
}

/** The one canonical block-property bag for a TYPE seed's backing block — a
 * `block-type` definition block, the type analog of `canonicalPropertySeed-
 * Properties`. It carries the declaration's identity/display facts (`block-type:
 * type-id` is the membership token `id`, the type analog of `propertyNameProp`)
 * plus `seed:key`/`seed:revision` provenance.
 *
 * Deliberately NOT PAGE_TYPE and NOT aliased — unlike a user-authored type (the
 * `#type` gesture / `createTypeBlock`, completed into a navigable `[[Label]]`
 * page by the typeify same-tx processor), a code type was never a page. Forcing
 * PAGE_TYPE + an alias here would be a visible behavior change at the C4 cutover
 * and risk `alias.collision` on the real type labels; the typeify carve-out for
 * seed rows keeps this bare row bare.
 *
 * `block-type:properties` (the on-block property refs) IS written from
 * `seed.properties` (C4a). A declared seed's `TypeContribution.properties` is
 * synthesized straight from the code declaration (`seedContribution` in
 * `typeDefinitionRegistry.ts`), never from the block's refList, so `repo.types`
 * is already correct without it — but the durable row must still match the
 * declaration: the materializer is create/restore-only and never repairs
 * payloads, so an empty list here would strand every kernel type's definition
 * block property-less forever (it feeds the definition block's own
 * property-panel display, and eventually the block-as-source-of-truth endgame).
 * Each ref is the target property's DETERMINISTIC backing-block id
 * (`propertyDefinitionBlockId(workspaceId, prop.seedKey)`); the property pass
 * runs before the type pass (`runWorkspaceSeedMaterialization`), so those blocks
 * exist — but the ref is by id anyway, so it resolves whenever the target
 * materializes (a withheld/contested property just dangles until it does, which
 * the refList `decodeValid` tolerates). A property without a `/property/` seed
 * key has no backing block to reference and is skipped with a warning; that
 * never happens for the kernel types (every referenced prop is a `seedProperty`),
 * and the synthesized `repo.types` contribution still carries it regardless. */
export const canonicalTypeSeedProperties = (
  seed: TypeSeedDeclaration,
  workspaceId: string,
): Record<string, unknown> => {
  const properties: Record<string, unknown> = {
    [blockTypeLabelProp.name]: blockTypeLabelProp.codec.encode(seed.label),
    [blockTypeTypeIdProp.name]: blockTypeTypeIdProp.codec.encode(seed.id),
    [seedKeyProp.name]: seedKeyProp.codec.encode(seed.seedKey),
    [seedRevisionProp.name]: seedRevisionProp.codec.encode(seed.revision),
  }
  if (seed.description !== undefined) {
    properties[blockTypeDescriptionProp.name] = blockTypeDescriptionProp.codec.encode(seed.description)
  }
  if (seed.color !== undefined) {
    properties[blockTypeColorProp.name] = blockTypeColorProp.codec.encode(seed.color)
  }
  if (seed.hideFromCompletion !== undefined) {
    properties[blockTypeHideFromCompletionProp.name] =
      blockTypeHideFromCompletionProp.codec.encode(seed.hideFromCompletion)
  }
  if (seed.hideFromBlockDisplay !== undefined) {
    properties[blockTypeHideFromBlockDisplayProp.name] =
      blockTypeHideFromBlockDisplayProp.codec.encode(seed.hideFromBlockDisplay)
  }
  if (seed.properties !== undefined && seed.properties.length > 0) {
    const refs: string[] = []
    for (const prop of seed.properties) {
      const propSeedKey = propertySeedKeyOf(prop)
      if (propSeedKey === undefined) {
        // Identify the entry by its `name` if it has a string one — NEVER
        // JSON.stringify(prop): a record entry can carry a bigint / circular value
        // that throws the serializer, which would re-abort the very pass this
        // skip path exists to protect.
        const propName = typeof prop === 'object' && prop !== null
          && typeof (prop as {name?: unknown}).name === 'string'
          ? (prop as {name: string}).name
          : '<non-property entry>'
        console.warn(
          `[canonicalTypeSeedProperties] type seed ${JSON.stringify(seed.seedKey)} references a ` +
          `property with no usable /property/ seed key (${propName}); omitting it from ` +
          'block-type:properties (repo.types still carries it from the declaration)',
        )
        continue
      }
      refs.push(propertyDefinitionBlockId(workspaceId, propSeedKey))
    }
    if (refs.length > 0) {
      properties[blockTypePropertiesProp.name] = blockTypePropertiesProp.codec.encode(refs)
    }
  }
  return addBlockTypeToProperties(properties, BLOCK_TYPE_TYPE)
}

interface SeedProbeRow {
  readonly id: string
  readonly workspace_id: string
  readonly properties_json: string
  readonly deleted: number
}

/** Result of a create/restore-only materialization pass. Shared by both the
 * property and type materializers (their outcomes are structurally identical). */
export interface SeedMaterializationResult {
  readonly created: number
  readonly restored: number
  readonly skippedReadOnly: boolean
}

export type PropertySeedMaterializationAccess =
  | {readonly allowed: true}
  | {readonly allowed: false; readonly reason: 'inactive-workspace' | 'read-only' | 'viewer'}

export interface AwaitPropertySeedMaterializationAccessOptions {
  readonly freshlyCreated: boolean
  readonly signal?: AbortSignal
}

const propertySeedAccessAbortError = (): DOMException =>
  new DOMException('Property seed materialization access was aborted', 'AbortError')

const throwIfPropertySeedAccessAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw propertySeedAccessAbortError()
}

/** Access/readiness gate for production seed triggers. Fresh workspace RPCs
 * prime the owner membership locally, so their bootstrap path need not wait.
 * Existing workspaces await the exact membership row: the App deliberately
 * defaults a not-yet-synced role to writable, which is safe for ordinary UX
 * behind server RLS but would otherwise enqueue every seed create as a viewer.
 *
 * The captured workspace is rechecked after the wait so a parked task cannot
 * write after the user switches away. Abort is owned by the trigger generation.
 *
 * DELIBERATELY NOT gated on §6 e2ee materializability (decision on PR #397, Codex
 * "defer seed scheduling until workspace access is known"). A `setActiveWorkspaceId`
 * reschedule can fire this pass before App's `resolveWorkspaceEntry` marks a locked
 * e2ee workspace read-only, so an owner could briefly write seed rows into a locked
 * workspace. We accept it: (1) it's not a leak — the local DB is plaintext regardless,
 * and an e2ee workspace's UPLOAD seals content via `requireCek`, which THROWS without
 * the key (`sync/transform.ts`), so a seed row is never uploaded plaintext; (2) the
 * rows are deterministic + idempotent, so they normalize once the workspace unlocks
 * and its real blocks materialize; (3) the PROPERTY seed path has the identical gate
 * (this same function) — it's a shared, pre-existing behavior, not type-specific — and
 * once App sets read-only, both the gate and the pass's final `isReadOnly` recheck stop
 * further writes. If this ever needs closing, add the materializability check HERE (the
 * shared gate) so both kinds benefit, not a type-only patch. */
export const awaitPropertySeedMaterializationAccess = async (
  repo: Repo,
  workspaceId: string,
  options: AwaitPropertySeedMaterializationAccessOptions,
): Promise<PropertySeedMaterializationAccess> => {
  throwIfPropertySeedAccessAborted(options.signal)
  if (repo.activeWorkspaceId !== workspaceId) {
    return {allowed: false, reason: 'inactive-workspace'}
  }
  if (repo.isReadOnly) return {allowed: false, reason: 'read-only'}

  if (!options.freshlyCreated) {
    const role = await awaitLocalMemberRole(repo, workspaceId, repo.user.id, {
      signal: options.signal,
    })
    throwIfPropertySeedAccessAborted(options.signal)
    if (repo.activeWorkspaceId !== workspaceId) {
      return {allowed: false, reason: 'inactive-workspace'}
    }
    if (role === 'viewer') return {allowed: false, reason: 'viewer'}
    if (repo.isReadOnly) return {allowed: false, reason: 'read-only'}
  }

  throwIfPropertySeedAccessAborted(options.signal)
  return {allowed: true}
}

const revisionFromProperties = (properties: Record<string, unknown>): number | undefined => {
  try {
    const raw = properties[seedRevisionProp.name]
    return raw === undefined ? undefined : seedRevisionProp.codec.decode(raw)
  } catch {
    return undefined
  }
}

// The materialization guards are shared verbatim by both kinds — property and
// type seeds probe the same deterministic-id namespace with the same poisoned-id
// / cross-workspace / provenance invariants. `label` names the caller so the
// error text stays accurate for whichever pass raised it.
const assertUniqueSeedKeys = (
  label: string,
  seeds: readonly {readonly seedKey: string}[],
): void => {
  const seen = new Set<string>()
  for (const seed of seeds) {
    if (seen.has(seed.seedKey)) {
      throw new Error(`[${label}] duplicate seed key ${JSON.stringify(seed.seedKey)}`)
    }
    seen.add(seed.seedKey)
  }
}

const assertSeedWorkspace = (
  label: string,
  id: string,
  expectedWorkspaceId: string,
  actualWorkspaceId: string,
): void => {
  if (actualWorkspaceId !== expectedWorkspaceId) {
    throw new Error(
      `[${label}] seed id ${id} belongs to workspace ${actualWorkspaceId}, ` +
      `not ${expectedWorkspaceId}`,
    )
  }
}

const assertSeedProvenance = (
  label: string,
  id: string,
  workspaceId: string,
  expectedSeedKey: string,
  properties: Record<string, unknown>,
): void => {
  const actualSeedKey = validSeedKeyForRow({id, workspaceId, properties})
  if (actualSeedKey !== expectedSeedKey) {
    throw new Error(
      `[${label}] seed id ${id} does not carry expected seed key ${expectedSeedKey}`,
    )
  }
}

const parseProbeProperties = (row: SeedProbeRow): Record<string, unknown> => {
  try {
    const value = JSON.parse(row.properties_json) as unknown
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  } catch {
    // Fall through to the collision error below.
  }
  return {}
}

/** The kind-specific inputs to `materializeSeeds`: everything that differs
 * between the property and type passes, which is only a handful of first-class
 * values. */
interface SeedMaterializationConfig<S extends {readonly seedKey: string; readonly revision: number}> {
  /** Names the caller in guard/error text (`materializePropertySeeds` / `materializeTypeSeeds`). */
  readonly label: string
  /** Deterministic backing-block id for a seed key (`property`/`type` variant). */
  readonly idFor: (workspaceId: string, seedKey: string) => string
  /** Deterministic parent page id (Properties / Types). */
  readonly parentFor: (workspaceId: string) => string
  /** Ensure the parent page (Properties / Types) exists before minting children.
   *  Idempotent + deterministic-id; called only when there's pending work, so the
   *  pass is self-sufficient rather than dependent on bootstrap ordering (see
   *  `materializeSeeds`). */
  readonly ensureParent: (repo: Repo, workspaceId: string) => Promise<unknown>
  readonly contentFor: (seed: S) => string
  /** Build the seed's on-block property bag. Receives `workspaceId` so the type
   *  pass can derive its `block-type:properties` refs' deterministic backing-block
   *  ids; the property pass ignores it. */
  readonly propertiesFor: (seed: S, workspaceId: string) => Record<string, unknown>
  readonly txDescription: string
  /** Optional pre-materialization filter, applied AFTER the read-only / empty
   *  guards and before the probe. Types drop contested-`id` seeds here; the
   *  property side has no analog (its registry handles name collisions upstream). */
  readonly preFilter?: (seeds: readonly S[]) => readonly S[]
  /** Optional per-seed declaration recheck, consulted INSIDE the write tx right
   *  before each seed's create/restore. The seed array is a snapshot taken before
   *  the pass's awaits (probe / ensure / tx setup); a facet change since may have
   *  removed a seed or made it contested (by key OR — types only — by membership
   *  id). Returning false skips it — create/restore is irreversible, so a stale
   *  write would leave a retired row the registry later republishes as a phantom
   *  block-id type. Receives the whole seed so the type side can check its id. Only
   *  the scheduled path wires this (against the live registry); direct callers pass
   *  an explicit array and omit it. */
  readonly stillMaterializable?: (seed: S) => boolean
}

/** Isolated create/restore-only seed materialization pass — the ONE copy of the
 * discipline both kinds run over the shared deterministic-id namespace. Callers
 * supply the exact declarations visible to their runtime and a concrete
 * workspace; production trigger/access-gate wiring intentionally lands in a
 * later sub-slice.
 *
 * Never repairs payloads: live stale rows only log, a tombstone restore
 * preserves its existing bag. The batched probe validates every occupied
 * deterministic id before entering the write transaction; one poisoned id
 * intentionally aborts the whole batch rather than partially materializing a
 * declaration set whose identity is suspect. Missing definitions are minted
 * beneath the deterministic parent page — which the pass ensures exists first
 * (`config.ensureParent`), so it doesn't depend on bootstrap having created it —
 * in one Automation transaction with pristine systemMint timestamps. The kind's
 * specifics (id / parent / ensure / content / bag / label / pre-filter) come
 * through `config`. */
const materializeSeeds = async <S extends {readonly seedKey: string; readonly revision: number}>(
  repo: Repo,
  workspaceId: string,
  seeds: readonly S[],
  config: SeedMaterializationConfig<S>,
  signal?: AbortSignal,
): Promise<SeedMaterializationResult> => {
  assertUniqueSeedKeys(config.label, seeds)
  if (repo.isReadOnly) return {created: 0, restored: 0, skippedReadOnly: true}
  if (seeds.length === 0) return {created: 0, restored: 0, skippedReadOnly: false}
  const materializable = config.preFilter ? config.preFilter(seeds) : seeds
  if (materializable.length === 0) return {created: 0, restored: 0, skippedReadOnly: false}

  const ids = materializable.map(seed => config.idFor(workspaceId, seed.seedKey))
  const placeholders = ids.map(() => '?').join(', ')
  const rows = await repo.db.getAll<SeedProbeRow>(
    `SELECT id, workspace_id, properties_json, deleted FROM blocks WHERE id IN (${placeholders})`,
    ids,
  )
  const seedsById = new Map(materializable.map(seed => [
    config.idFor(workspaceId, seed.seedKey), seed,
  ] as const))
  const rowsById = new Map(rows.map(row => {
    assertSeedWorkspace(config.label, row.id, workspaceId, row.workspace_id)
    const seed = seedsById.get(row.id)
    if (!seed) throw new Error(`[${config.label}] unexpected probe row ${row.id}`)
    const properties = parseProbeProperties(row)
    assertSeedProvenance(config.label, row.id, workspaceId, seed.seedKey, properties)
    return [row.id, {row, properties}] as const
  }))

  const pending = materializable.filter((seed, index) => {
    const probed = rowsById.get(ids[index]!)
    if (!probed || probed.row.deleted === 1) return true
    const storedRevision = revisionFromProperties(probed.properties)
    if (storedRevision !== undefined && storedRevision < seed.revision) {
      console.warn(
        `[definitionSeeds] ${seed.seedKey} revision ${storedRevision} trails code revision ${seed.revision}; ` +
        'background materialization does not repair payloads',
      )
    }
    return false
  })
  if (pending.length === 0) return {created: 0, restored: 0, skippedReadOnly: false}

  // The probe above awaited; if the generation aborted since (the user switched
  // workspaces — `setActiveWorkspaceId` aborts it), don't ensure the page or open
  // the write tx. `repo.tx` pins writes by the row's own workspace, so materializing
  // here would create backing blocks in the workspace the user just left, past the
  // caller's pre-probe abort check. The write is idempotent and scope-correct, but
  // the active-workspace guard exists to not do it — so honor the abort at the last
  // point before the tx.
  if (signal?.aborted) return {created: 0, restored: 0, skippedReadOnly: false}

  // Ensure the parent system page exists before minting children. `tx.create`
  // enforces `requireParentInWorkspace`, so a create beneath a not-yet-materialized
  // Properties/Types page throws `ParentNotFoundError`. That's reachable: a
  // `setActiveWorkspaceId`-driven reschedule (esp. for TYPE seeds, whose registry
  // has no priming gate) can fire this pass before bootstrap's `ensureSystemPages`
  // runs. Ensuring here — idempotent, deterministic-id, a cached read once the page
  // exists, and concurrency-safe against bootstrap's own ensure (it re-checks
  // existence inside its tx) — makes the pass self-sufficient rather than a
  // spurious throw that waits for the next open/seed change.
  await config.ensureParent(repo, workspaceId)

  let created = 0
  let restored = 0
  const parentId = config.parentFor(workspaceId)
  await repo.tx(async tx => {
    // `ensureParent` (and `repo.tx`'s own tx_context setup) awaited since the check
    // above; a switch-away can land in that window. Early-out here so an aborted
    // generation skips even the read-only revalidation below (whose asserts would
    // otherwise log a spurious non-abort failure); the atomic write guard is the
    // second recheck, immediately before the write loop.
    if (signal?.aborted) return
    const currentById = new Map<string, Awaited<ReturnType<typeof tx.get>>>()
    // Revalidate the complete declaration set under the same write lock before
    // the first mutation. The outside batch is only a fast no-work probe; it
    // cannot authorize a partial write if another actor poisons a previously
    // valid deterministic id between the probe and this transaction.
    for (const seed of materializable) {
      const id = config.idFor(workspaceId, seed.seedKey)
      const current = await tx.get(id)
      if (current) {
        assertSeedWorkspace(config.label, id, workspaceId, current.workspaceId)
        assertSeedProvenance(config.label, id, workspaceId, seed.seedKey, current.properties)
      }
      currentById.set(id, current)
    }
    // The revalidation reads above are each awaited; a switch-away OR a role
    // demotion can land during one of them. Recheck once more here — the last
    // read-only point before the write loop — so neither writes anything. This is
    // the atomic guard: the write loop below is the mutation unit (returning from
    // inside it would commit the partial writes already made), so this is the
    // correct final checkpoint, not a per-write check.
    //
    // `repo.isReadOnly`: the top-of-fn check and the access gate both ran before
    // these awaits, but the seed write is `ChangeScope.Automation`, which
    // `scopeAllowedInReadOnly` PERMITS — so a flip to viewer mid-pass would
    // otherwise create/restore backing rows for a viewer and enqueue RLS-rejected
    // writes. Re-read it at the last moment.
    if (signal?.aborted || repo.isReadOnly) return
    for (const seed of materializable) {
      const id = config.idFor(workspaceId, seed.seedKey)
      // Declaration recheck (scheduled path): the seed array was snapshotted before
      // the awaits above; if a facet change since removed this seed or made it
      // contested, skip it. create/restore-only can't undo a write, so a stale
      // create would strand a retired row the registry republishes as a phantom.
      if (config.stillMaterializable && !config.stillMaterializable(seed)) continue
      const current = currentById.get(id) ?? null
      if (current && !current.deleted) continue
      if (current?.deleted) {
        await tx.restore(id, undefined, {skipMetadata: true})
        restored += 1
        continue
      }
      await tx.create({
        id,
        workspaceId,
        parentId,
        orderKey: 'a0',
        content: config.contentFor(seed),
        properties: config.propertiesFor(seed, workspaceId),
      }, {systemMint: true})
      created += 1
    }
  }, {scope: ChangeScope.Automation, description: config.txDescription})

  return {created, restored, skippedReadOnly: false}
}

/** Create/restore-only PROPERTY seed pass — missing definitions minted beneath the
 * Properties page, which the pass ensures exists first. See `materializeSeeds`. */
export const materializePropertySeeds = (
  repo: Repo,
  workspaceId: string,
  seeds: readonly AnyPropertySeedDeclaration[],
  signal?: AbortSignal,
  revalidateAgainstRegistry = false,
): Promise<SeedMaterializationResult> =>
  materializeSeeds(repo, workspaceId, seeds, {
    label: 'materializePropertySeeds',
    idFor: propertyDefinitionBlockId,
    parentFor: propertiesPageBlockId,
    ensureParent: getOrCreatePropertiesPage,
    contentFor: seed => seed.name,
    propertiesFor: canonicalPropertySeedProperties,
    txDescription: 'materialize property definitions',
    stillMaterializable: revalidateAgainstRegistry
      ? seed => {
          const reg = repo.propertyDefinitions
          // Not the live registry for this workspace (direct caller with an explicit
          // array, or a switch-away the abort guard already handles) → trust the array.
          if (reg?.workspaceId !== workspaceId) return true
          return reg.seedsByKey.has(seed.seedKey)
        }
      : undefined,
  }, signal)

/** Keep only the id-WINNER of each membership id: when several seeds in the batch
 * claim one `id` (an id collision `assertUniqueSeedKeys` can't catch — they carry
 * DIFFERENT keys, hashing to different deterministic block ids, yet each would
 * materialize a `block-type` block claiming the same `block-type:type-id`), the
 * LOWEST seed key wins and the losers are dropped. This is the direct-caller twin of
 * `synthesizeSeedTypes`' registry resolution, so a direct-array materialization set
 * agrees with what the registry publishes and binds. The winner is deterministic
 * (order-independent), so exactly ONE backing block per id is ever materialized — no
 * reorder-dependent flip that this create/restore-only pass could never delete.
 * Unlike the former fail-closed drop-both behavior, the id still materializes (its
 * one stable winner) rather than stranding every contender until the clash is
 * manually resolved — an id clash now degrades gracefully. */
const winnerTypeSeeds = (
  seeds: readonly TypeSeedDeclaration[],
): readonly TypeSeedDeclaration[] => {
  const winnerById = new Map<string, TypeSeedDeclaration>()
  for (const seed of seeds) {
    const prior = winnerById.get(seed.id)
    if (!prior || typeSeedKeyOutranks(seed.seedKey, prior.seedKey)) winnerById.set(seed.id, seed)
  }
  const winners = new Set(winnerById.values())
  return seeds.filter(seed => winners.has(seed))
}

/** Create/restore-only TYPE seed pass — missing definitions minted beneath the
 * Types page, which the pass ensures exists first. Unlike the property pass it
 * winner-resolves a membership-`id` collision first (`winnerTypeSeeds`, via
 * `preFilter`): the lowest-seed-key winner materializes and the losers are dropped,
 * so exactly one stable backing block exists per id and an id clash degrades
 * gracefully; the property side folds its collision handling into the registry
 * upstream. Its `block-type` backing rows are kept bare (no PAGE_TYPE / alias) by
 * the typeify same-tx processor's `/type/`-seed carve-out. See `materializeSeeds`. */
export const materializeTypeSeeds = (
  repo: Repo,
  workspaceId: string,
  seeds: readonly TypeSeedDeclaration[],
  signal?: AbortSignal,
  revalidateAgainstRegistry = false,
): Promise<SeedMaterializationResult> =>
  materializeSeeds(repo, workspaceId, seeds, {
    label: 'materializeTypeSeeds',
    idFor: typeDefinitionBlockId,
    parentFor: typesPageBlockId,
    ensureParent: getOrCreateTypesPage,
    contentFor: seed => seed.label,
    propertiesFor: canonicalTypeSeedProperties,
    txDescription: 'materialize type definitions',
    preFilter: winnerTypeSeeds,
    stillMaterializable: revalidateAgainstRegistry
      ? seed => {
          const reg = repo.typeDefinitions
          // Not the live registry for this workspace (direct caller with an explicit
          // array, or a switch-away the abort guard already handles) → trust the array.
          if (reg?.workspaceId !== workspaceId) return true
          // Materialize only if this seed is STILL the live id-winner for its key and
          // that key isn't contested. `seedKeyById.get(id) === seedKey` IS the winner
          // test; it subsumes both a demotion (an install change since the snapshot
          // handed the membership id to a lower-seed-key declaration) AND a same-key
          // id REPLACEMENT (a plugin update rebound this key to a new id) — in either
          // case this (key, id) is no longer the registry's winning pair, so writing
          // it would strand a stale/loser backing block this create/restore-only pass
          // can never delete. Matches `workspaceSeeds` / `materializingTypeSeeds`.
          // Identity only, not revision: a revision bump is a payload-version change
          // materialization deliberately doesn't chase (the reschedule diff ignores it
          // too, §4.3/§6.1), so gating on it would reject the snapshot with no dirty
          // re-run to replace it.
          return !reg.contestedSeedKeys.has(seed.seedKey)
            && reg.seedKeyById.get(seed.id) === seed.seedKey
        }
      : undefined,
  }, signal)
