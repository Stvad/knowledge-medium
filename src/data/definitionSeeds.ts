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
import {propertiesPageBlockId} from '@/data/propertiesPage'
import {typesPageBlockId} from '@/data/typesPage'
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
 * seed rows keeps this bare row bare. `block-type:properties` (the on-block
 * property refs) is also omitted. This is NOT a functional gap for type
 * resolution: a declared seed's `TypeContribution.properties` is synthesized
 * straight from the code declaration (`seedContribution` in
 * `typeDefinitionRegistry.ts`), never from the block's refList — so a C4 seed
 * carrying `properties` resolves correctly through `repo.types` even with the
 * refs absent from the row. Writing the on-block refs (which only feeds the
 * definition block's own property-panel display) needs each target's
 * deterministic id derived from a seeded property HANDLE and lands with C4; no
 * current type seed declares `properties`. */
export const canonicalTypeSeedProperties = (
  seed: TypeSeedDeclaration,
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
 * write after the user switches away. Abort is owned by the trigger generation. */
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

/** Isolated create/restore-only property seed pass. Callers supply the exact
 * declarations visible to their runtime and a concrete workspace. Production
 * trigger/access-gate wiring intentionally lands in a later sub-slice.
 *
 * The background pass never repairs payloads: live stale rows only log, and a
 * tombstone restore preserves its existing bag. The batched probe validates
 * every occupied deterministic id before entering the write transaction; one
 * poisoned id intentionally aborts the whole batch rather than partially
 * materializing a declaration set whose identity is suspect. Missing
 * definitions are minted beneath the already-ensured deterministic Properties
 * page in one Automation transaction with pristine systemMint timestamps. */
export const materializePropertySeeds = async (
  repo: Repo,
  workspaceId: string,
  seeds: readonly AnyPropertySeedDeclaration[],
): Promise<SeedMaterializationResult> => {
  assertUniqueSeedKeys('materializePropertySeeds', seeds)
  if (repo.isReadOnly) return {created: 0, restored: 0, skippedReadOnly: true}
  if (seeds.length === 0) return {created: 0, restored: 0, skippedReadOnly: false}

  const ids = seeds.map(seed => propertyDefinitionBlockId(workspaceId, seed.seedKey))
  const placeholders = ids.map(() => '?').join(', ')
  const rows = await repo.db.getAll<SeedProbeRow>(
    `SELECT id, workspace_id, properties_json, deleted FROM blocks WHERE id IN (${placeholders})`,
    ids,
  )
  const seedsById = new Map(seeds.map(seed => [
    propertyDefinitionBlockId(workspaceId, seed.seedKey), seed,
  ] as const))
  const rowsById = new Map(rows.map(row => {
    assertSeedWorkspace('materializePropertySeeds', row.id, workspaceId, row.workspace_id)
    const seed = seedsById.get(row.id)
    if (!seed) throw new Error(`[materializePropertySeeds] unexpected probe row ${row.id}`)
    const properties = parseProbeProperties(row)
    assertSeedProvenance('materializePropertySeeds', row.id, workspaceId, seed.seedKey, properties)
    return [row.id, {row, properties}] as const
  }))

  const pending = seeds.filter((seed, index) => {
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

  let created = 0
  let restored = 0
  const parentId = propertiesPageBlockId(workspaceId)
  await repo.tx(async tx => {
    const currentById = new Map<string, Awaited<ReturnType<typeof tx.get>>>()
    // Revalidate the complete declaration set under the same write lock before
    // the first mutation. The outside batch is only a fast no-work probe; it
    // cannot authorize a partial write if another actor poisons a previously
    // valid deterministic id between the probe and this transaction.
    for (const seed of seeds) {
      const id = propertyDefinitionBlockId(workspaceId, seed.seedKey)
      const current = await tx.get(id)
      if (current) {
        assertSeedWorkspace('materializePropertySeeds', id, workspaceId, current.workspaceId)
        assertSeedProvenance('materializePropertySeeds', id, workspaceId, seed.seedKey, current.properties)
      }
      currentById.set(id, current)
    }
    for (const seed of seeds) {
      const id = propertyDefinitionBlockId(workspaceId, seed.seedKey)
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
        content: seed.name,
        properties: canonicalPropertySeedProperties(seed),
      }, {systemMint: true})
      created += 1
    }
  }, {scope: ChangeScope.Automation, description: 'materialize property definitions'})

  return {created, restored, skippedReadOnly: false}
}

/** Keep the first seed per membership `id`, warning on a collision. Two seeds
 * with different keys but the same `id` are an authoring error: they hash to
 * DIFFERENT deterministic block ids (unique keys), so `assertUniqueSeedKeys`
 * doesn't catch them, yet both would materialize a backing block claiming the
 * same `block-type:type-id` — a phantom loser row `buildTypeDefinitionRegistry`
 * then drops from the runtime map (`seedsByKey` retains it; the id-dedup happens
 * separately in `typesById` synthesis). Resolve to the registry's SAME keep-first
 * winner here so the loser is never persisted. Drop-and-warn (not throw) so one
 * malformed dynamic contribution can't abort the shared pass — matching the
 * property registry's name-collision handling. */
const dedupeTypeSeedsById = (
  seeds: readonly TypeSeedDeclaration[],
): readonly TypeSeedDeclaration[] => {
  const byId = new Map<string, TypeSeedDeclaration>()
  for (const seed of seeds) {
    const prior = byId.get(seed.id)
    if (prior) {
      console.warn(
        `[materializeTypeSeeds] duplicate type seed id ${JSON.stringify(seed.id)} ` +
        `(keys ${JSON.stringify(prior.seedKey)} + ${JSON.stringify(seed.seedKey)}); ` +
        'keeping first, not materializing the collider',
      )
      continue
    }
    byId.set(seed.id, seed)
  }
  return [...byId.values()]
}

/** Isolated create/restore-only TYPE seed pass — the exact structural mirror of
 * `materializePropertySeeds`, over the same deterministic-id namespace and the
 * same probe → revalidate-under-lock → create/restore discipline (one poisoned
 * id aborts the whole batch; a tombstone restore preserves its bag; live stale
 * rows only log). Differences are only the kind's specifics: `typeDefinitionBlockId`
 * for identity, the Types page for the parent, `canonicalTypeSeedProperties` for
 * the bag, and an id-dedup pass (`dedupeTypeSeedsById`) the property side folds
 * into its name-collision handling upstream. `block-type` backing blocks would
 * trip the typeify same-tx processor into PAGE_TYPE + alias; the processor's seed
 * carve-out (a valid `/type/` seed row) keeps this write inert. */
export const materializeTypeSeeds = async (
  repo: Repo,
  workspaceId: string,
  seeds: readonly TypeSeedDeclaration[],
): Promise<SeedMaterializationResult> => {
  assertUniqueSeedKeys('materializeTypeSeeds', seeds)
  if (repo.isReadOnly) return {created: 0, restored: 0, skippedReadOnly: true}
  if (seeds.length === 0) return {created: 0, restored: 0, skippedReadOnly: false}
  // Resolve membership-id collisions to keep-first winners BEFORE any write, so a
  // dup-id loser never persists a phantom backing block (Codex P2).
  const materializable = dedupeTypeSeedsById(seeds)

  const ids = materializable.map(seed => typeDefinitionBlockId(workspaceId, seed.seedKey))
  const placeholders = ids.map(() => '?').join(', ')
  const rows = await repo.db.getAll<SeedProbeRow>(
    `SELECT id, workspace_id, properties_json, deleted FROM blocks WHERE id IN (${placeholders})`,
    ids,
  )
  const seedsById = new Map(materializable.map(seed => [
    typeDefinitionBlockId(workspaceId, seed.seedKey), seed,
  ] as const))
  const rowsById = new Map(rows.map(row => {
    assertSeedWorkspace('materializeTypeSeeds', row.id, workspaceId, row.workspace_id)
    const seed = seedsById.get(row.id)
    if (!seed) throw new Error(`[materializeTypeSeeds] unexpected probe row ${row.id}`)
    const properties = parseProbeProperties(row)
    assertSeedProvenance('materializeTypeSeeds', row.id, workspaceId, seed.seedKey, properties)
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

  let created = 0
  let restored = 0
  const parentId = typesPageBlockId(workspaceId)
  await repo.tx(async tx => {
    const currentById = new Map<string, Awaited<ReturnType<typeof tx.get>>>()
    // Revalidate the complete declaration set under the same write lock before
    // the first mutation — the outside batch is only a fast no-work probe.
    for (const seed of materializable) {
      const id = typeDefinitionBlockId(workspaceId, seed.seedKey)
      const current = await tx.get(id)
      if (current) {
        assertSeedWorkspace('materializeTypeSeeds', id, workspaceId, current.workspaceId)
        assertSeedProvenance('materializeTypeSeeds', id, workspaceId, seed.seedKey, current.properties)
      }
      currentById.set(id, current)
    }
    for (const seed of materializable) {
      const id = typeDefinitionBlockId(workspaceId, seed.seedKey)
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
        content: seed.label,
        properties: canonicalTypeSeedProperties(seed),
      }, {systemMint: true})
      created += 1
    }
  }, {scope: ChangeScope.Automation, description: 'materialize type definitions'})

  return {created, restored, skippedReadOnly: false}
}
