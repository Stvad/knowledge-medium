import {v5 as uuidv5} from 'uuid'
import {ChangeScope, type BlockData} from '@/data/api'
import {isPropertySeedKey, type AnyPropertySeedDeclaration} from '@/data/propertySeeds'
import {
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
import {PROPERTY_SCHEMA_TYPE} from '@/data/blockTypes'
import {propertiesPageBlockId} from '@/data/propertiesPage'
import type {Repo} from '@/data/repo'

/** Namespace for every deterministic code-owned definition block. Identity is
 * always workspace-scoped: uuidv5(`${workspaceId}:${seedKey}`, namespace). */
export const DEFINITION_SEED_NS = '737c2e9d-f3e9-4c99-94ef-e1cbec920e30'

export const propertyDefinitionBlockId = (workspaceId: string, seedKey: string): string =>
  uuidv5(`${workspaceId}:${seedKey}`, DEFINITION_SEED_NS)

type SeedIdentityRow = Pick<BlockData, 'id' | 'workspaceId' | 'properties'>

const validSeedKeyForRow = (row: SeedIdentityRow): string | undefined => {
  const rawSeedKey = row.properties[seedKeyProp.name]
  let seedKey: string
  try {
    seedKey = seedKeyProp.codec.decode(rawSeedKey)
  } catch {
    return undefined
  }
  return isPropertySeedKey(seedKey) && row.id === propertyDefinitionBlockId(row.workspaceId, seedKey)
    ? seedKey
    : undefined
}

/** A seed:key property alone proves nothing. A row is code-seeded only when
 * the key has declaration grammar and its id satisfies the deterministic
 * equation for that row's own workspace. */
export const isValidSeededDefinition = (row: SeedIdentityRow): boolean =>
  validSeedKeyForRow(row) !== undefined

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

interface SeedProbeRow {
  readonly id: string
  readonly workspace_id: string
  readonly properties_json: string
  readonly deleted: number
}

export interface PropertySeedMaterializationResult {
  readonly created: number
  readonly restored: number
  readonly skippedReadOnly: boolean
}

const revisionFromProperties = (properties: Record<string, unknown>): number | undefined => {
  try {
    const raw = properties[seedRevisionProp.name]
    return raw === undefined ? undefined : seedRevisionProp.codec.decode(raw)
  } catch {
    return undefined
  }
}

const assertUniqueSeedKeys = (seeds: readonly AnyPropertySeedDeclaration[]): void => {
  const seen = new Set<string>()
  for (const seed of seeds) {
    if (seen.has(seed.seedKey)) {
      throw new Error(`[materializePropertySeeds] duplicate seed key ${JSON.stringify(seed.seedKey)}`)
    }
    seen.add(seed.seedKey)
  }
}

const assertSeedWorkspace = (
  id: string,
  expectedWorkspaceId: string,
  actualWorkspaceId: string,
): void => {
  if (actualWorkspaceId !== expectedWorkspaceId) {
    throw new Error(
      `[materializePropertySeeds] seed id ${id} belongs to workspace ${actualWorkspaceId}, ` +
      `not ${expectedWorkspaceId}`,
    )
  }
}

const assertSeedProvenance = (
  id: string,
  workspaceId: string,
  expectedSeedKey: string,
  properties: Record<string, unknown>,
): void => {
  const actualSeedKey = validSeedKeyForRow({id, workspaceId, properties})
  if (actualSeedKey !== expectedSeedKey) {
    throw new Error(
      `[materializePropertySeeds] seed id ${id} does not carry expected seed key ${expectedSeedKey}`,
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
 * tombstone restore preserves its existing bag. Missing definitions are minted
 * beneath the already-ensured deterministic Properties page in one Automation
 * transaction with pristine systemMint timestamps. */
export const materializePropertySeeds = async (
  repo: Repo,
  workspaceId: string,
  seeds: readonly AnyPropertySeedDeclaration[],
): Promise<PropertySeedMaterializationResult> => {
  assertUniqueSeedKeys(seeds)
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
    assertSeedWorkspace(row.id, workspaceId, row.workspace_id)
    const seed = seedsById.get(row.id)
    if (!seed) throw new Error(`[materializePropertySeeds] unexpected probe row ${row.id}`)
    const properties = parseProbeProperties(row)
    assertSeedProvenance(row.id, workspaceId, seed.seedKey, properties)
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
    for (const seed of pending) {
      const id = propertyDefinitionBlockId(workspaceId, seed.seedKey)
      // Recheck under the write lock: another trigger/device-local task may
      // have materialized the deterministic id after the batched probe.
      const current = await tx.get(id)
      if (current) {
        assertSeedWorkspace(id, workspaceId, current.workspaceId)
        assertSeedProvenance(id, workspaceId, seed.seedKey, current.properties)
      }
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
