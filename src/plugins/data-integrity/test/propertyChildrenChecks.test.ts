// @vitest-environment node
/**
 * The audit's property-children checks (#1011's read-only half): duplicate
 * field rows, cell coverage, and cell-vs-children divergence on a workspace
 * switched to property blocks.
 *
 * Every row is written RAW, so no processor folds a duplicate, materializes a
 * missing field row or re-projects a stale cell before the audit reads it —
 * the shape a sync-applied row or a cell-only write leaves.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, seedProperty, type BlockData } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'
import { propertyNameProp } from '@/data/properties'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { definitionSeedsFacet } from '@/data/facets'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import {
  BLOCKS_SYNCED_RAW_TABLE, BLOCKS_TABLE_COLUMN_NAMES, blockToRowParams, blockToSyncedRowParams,
} from '@/data/blockSchema'
import { runConsistencyAudit, type ConsistencyCheckResult } from '../audit'
import { runPropertyCellDivergenceCheck } from '../propertyChildrenChecks'
import { runConsistencyAuditNow } from '../schedule'
import { resetConsistencyAuditStore } from '../store'

const WS = 'ws-props'

const statusProp = seedProperty({
  seedKey: 'test/property/status',
  revision: 1,
  name: 'demo:status',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

const ownerProp = seedProperty({
  seedKey: 'test/property/owner',
  revision: 1,
  name: 'demo:owner',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

const PROPERTY_CHECKS = [
  'property_field_row_duplicates',
  'property_cell_coverage',
  'property_cell_divergence',
] as const

let sharedDb: TestDb
let repo: Repo
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
afterEach(() => {
  vi.restoreAllMocks()
  resetConsistencyAuditStore()
})
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({ db: sharedDb.db, user: { id: 'user-1' } }).repo
  installRuntime()
  // `fieldIdOf` resolves synchronously; before the first snapshot every name
  // reads as identity-unavailable.
  await repo.whenPropertyDefinitionsReady(WS)
})

const installRuntime = () => {
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    definitionSeedsFacet.of(statusProp, { source: 'test' }),
    definitionSeedsFacet.of(ownerProp, { source: 'test' }),
  ], { repo, workspaceId: WS, safeMode: false }))
  repo.setActiveWorkspaceId(WS)
}

const setMode = (mode: string) => sharedDb.db.execute(
  `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time, properties_migration)
   VALUES (?, 'ws', 'user-1', 1, 1, ?)`, [WS, mode])

const fieldIdOf = (name: string): string => {
  const resolution = repo.propertySchemaResolverFor(WS).resolve(name)
  if (resolution.status !== 'resolved') throw new Error(`${name} does not resolve: ${resolution.status}`)
  return resolution.schema.fieldId
}

const INSERT_BLOCK_SQL =
  `INSERT INTO blocks (${BLOCKS_TABLE_COLUMN_NAMES.join(', ')}) ` +
  `VALUES (${BLOCKS_TABLE_COLUMN_NAMES.map(() => '?').join(', ')})`

const block = (id: string, overrides: Partial<BlockData> = {}): BlockData => ({
  id,
  workspaceId: WS,
  parentId: null,
  orderKey: `a-${id}`,
  content: id,
  properties: {},
  references: [],
  createdAt: 1,
  updatedAt: 1,
  userUpdatedAt: 1,
  createdBy: 'user-1',
  updatedBy: 'user-1',
  deleted: false,
  ...overrides,
})

/** Raw rows in one writeTransaction: the triggers maintain the side indexes,
 *  no post-commit processor runs. */
const insertRaw = (...rows: BlockData[]) => sharedDb.db.writeTransaction(async tx => {
  for (const row of rows) await tx.execute(INSERT_BLOCK_SQL, blockToRowParams(row))
})

const owner = (id: string, properties: Record<string, unknown>, overrides: Partial<BlockData> = {}) =>
  block(id, { properties, ...overrides })

const fieldRow = (id: string, ownerId: string, property: string, overrides: Partial<BlockData> = {}) =>
  block(id, {
    parentId: ownerId,
    content: `::((${fieldIdOf(property)}))`,
    referenceTargetId: fieldIdOf(property),
    isFieldForm: true,
    ...overrides,
  })

const valueChild = (id: string, fieldRowId: string, content: string, overrides: Partial<BlockData> = {}) =>
  block(id, { parentId: fieldRowId, content, ...overrides })

const audit = async (): Promise<Record<string, ConsistencyCheckResult>> =>
  (await runConsistencyAudit(sharedDb.db, WS, 0, { repo })).checks

describe('property-children checks: mode gate', () => {
  it('skips every property-children check, naming the mode, before the switch', async () => {
    await setMode('cell')
    await insertRaw(
      owner('o1', { [statusProp.name]: 'stale' }),
      fieldRow('f1', 'o1', statusProp.name),
      fieldRow('f2', 'o1', statusProp.name),
    )

    const checks = await audit()

    for (const name of PROPERTY_CHECKS) {
      expect(checks[name]).toMatchObject({ status: 'skipped' })
      expect(String(checks[name].reason)).toContain("'cell'")
    }
  })

  it('reads a workspace with no local row as not switched', async () => {
    const checks = await audit()

    for (const name of PROPERTY_CHECKS) expect(checks[name].status).toBe('skipped')
  })
})

describe('property_field_row_duplicates', () => {
  beforeEach(() => setMode('children'))

  it('flags two live field rows for one (owner, definition), sampling the owner', async () => {
    await insertRaw(
      owner('o1', { [statusProp.name]: 'a' }),
      fieldRow('f1', 'o1', statusProp.name),
      fieldRow('f2', 'o1', statusProp.name),
      valueChild('v1', 'f1', 'a'),
    )

    const check = (await audit()).property_field_row_duplicates

    expect(check).toMatchObject({ status: 'anomaly', duplicatePairs: 1, extraFieldRows: 1, samples: ['o1'] })
  })

  it('does not count a tombstoned duplicate, another definition, another owner, or an unmarked row', async () => {
    await insertRaw(
      owner('o1', { [statusProp.name]: 'a', [ownerProp.name]: 'b' }),
      owner('o2', { [statusProp.name]: 'a' }),
      fieldRow('f1', 'o1', statusProp.name),
      fieldRow('f1-dead', 'o1', statusProp.name, { deleted: true }),
      fieldRow('f1-other-def', 'o1', ownerProp.name),
      fieldRow('f1-unmarked', 'o1', statusProp.name, { isFieldForm: false }),
      fieldRow('f2', 'o2', statusProp.name),
      valueChild('v1', 'f1', 'a'),
      valueChild('v1b', 'f1-other-def', 'b'),
      valueChild('v2', 'f2', 'a'),
    )

    const check = (await audit()).property_field_row_duplicates

    expect(check).toMatchObject({ status: 'ok', duplicatePairs: 0, samples: [] })
  })
})

describe('property_cell_coverage', () => {
  beforeEach(() => setMode('children'))

  it('flags a registered cell with no field row — the shared coverage survey', async () => {
    await insertRaw(owner('o1', { [statusProp.name]: 'a' }))

    const check = (await audit()).property_cell_coverage

    expect(check).toMatchObject({
      status: 'anomaly',
      missing: { cells: 1, blocks: 1, keys: [{ key: statusProp.name, cells: 1, blockIds: ['o1'] }] },
      samples: ['o1'],
    })
  })

  it('flags a cell the codec refuses, and one whose only field row is tombstoned', async () => {
    await insertRaw(
      owner('o1', { [statusProp.name]: 42 }),
      owner('o2', { [statusProp.name]: 'a' }),
      fieldRow('f2', 'o2', statusProp.name, { deleted: true }),
    )

    const check = (await audit()).property_cell_coverage

    expect(check).toMatchObject({
      status: 'anomaly',
      uncoveredCells: 2,
      missing: { cells: 0 },
      refused: { cells: 1, keys: [{ key: statusProp.name, blockIds: ['o1'] }] },
      deletedThroughChildren: { cells: 1, keys: [{ key: statusProp.name, blockIds: ['o2'] }] },
      samples: ['o1', 'o2'],
    })
  })

  it('reads ok when every registered cell has its field row', async () => {
    await insertRaw(
      owner('o1', { [statusProp.name]: 'a' }),
      fieldRow('f1', 'o1', statusProp.name),
      valueChild('v1', 'f1', 'a'),
    )

    expect((await audit()).property_cell_coverage).toMatchObject({ status: 'ok', samples: [] })
  })

  it('skips without a repo to resolve keys against, and the SQL-only check still runs', async () => {
    await insertRaw(owner('o1', { [statusProp.name]: 'a' }))

    const checks = (await runConsistencyAudit(sharedDb.db, WS, 0)).checks

    expect(checks.property_cell_coverage.status).toBe('skipped')
    expect(checks.property_cell_divergence.status).toBe('skipped')
    expect(checks.property_field_row_duplicates.status).toBe('ok')
  })
})

describe('property_cell_divergence', () => {
  beforeEach(() => setMode('children'))

  it('reads ok when each cell key equals its projection from the value children', async () => {
    await insertRaw(
      owner('o1', { [statusProp.name]: 'a', [ownerProp.name]: 'b' }),
      fieldRow('f1', 'o1', statusProp.name),
      fieldRow('f2', 'o1', ownerProp.name),
      valueChild('v1', 'f1', 'a'),
      valueChild('v2', 'f2', 'b'),
    )

    const check = (await audit()).property_cell_divergence

    expect(check).toMatchObject({ status: 'ok', ownersScanned: 1, fieldsChecked: 2, divergentCells: 0 })
  })

  it.each([
    ['[[Old]]', '[[Old]]', 'ok'],
    ['[[Old]]', '[[New]]', 'anomaly'],
    ['ordinary', '[[New]]', 'anomaly'],
    [undefined, '[[New]]', 'anomaly'],
  ])('accepts only unchanged legacy names: cell %s, row %s', async (stored, content, status) => {
    await insertRaw(
      owner('legacy', stored === undefined ? {} : {[propertyNameProp.name]: stored}),
      fieldRow('name-field', 'legacy', propertyNameProp.name),
      valueChild('name-value', 'name-field', content!),
    )
    const before = await sharedDb.db.getAll('SELECT * FROM blocks ORDER BY id')
    expect((await audit()).property_cell_divergence).toMatchObject({status, divergentCells: status === 'ok' ? 0 : 1})
    expect(await sharedDb.db.getAll('SELECT * FROM blocks ORDER BY id')).toEqual(before)
  })

  it('flags a cell that disagrees with its value child, by key and kind', async () => {
    await insertRaw(
      owner('o1', { [statusProp.name]: 'stale', [ownerProp.name]: 'b' }),
      fieldRow('f1', 'o1', statusProp.name),
      fieldRow('f2', 'o1', ownerProp.name),
      valueChild('v1', 'f1', 'fresh'),
      valueChild('v2', 'f2', 'b'),
    )

    const check = (await audit()).property_cell_divergence

    expect(check).toMatchObject({
      status: 'anomaly',
      divergentCells: 1,
      divergentBlocks: 1,
      byKind: { cellDiffers: 1, cellMissing: 0, cellExtra: 0 },
      keys: [{ key: statusProp.name, cells: 1, blockIds: ['o1'] }],
      samples: ['o1'],
    })
  })

  it('flags a cell missing a key its field row projects', async () => {
    await insertRaw(
      owner('o1', {}),
      fieldRow('f1', 'o1', statusProp.name),
      valueChild('v1', 'f1', 'a'),
    )

    expect((await audit()).property_cell_divergence).toMatchObject({
      status: 'anomaly', byKind: { cellMissing: 1, cellDiffers: 0, cellExtra: 0 },
    })
  })

  it('flags a cell key whose live field row projects nothing', async () => {
    await insertRaw(
      owner('o1', { [statusProp.name]: 'a' }),
      fieldRow('f1', 'o1', statusProp.name),
    )

    expect((await audit()).property_cell_divergence).toMatchObject({
      status: 'anomaly', byKind: { cellExtra: 1, cellMissing: 0, cellDiffers: 0 },
    })
  })

  it('projects only live, unmarked value children in order, as the processor does', async () => {
    await insertRaw(
      owner('o1', { [statusProp.name]: 'first' }),
      fieldRow('f1', 'o1', statusProp.name),
      valueChild('v-dead', 'f1', 'deleted', { orderKey: 'a0', deleted: true }),
      valueChild('v-marked', 'f1', 'nested', { orderKey: 'a1', isFieldForm: true }),
      valueChild('v-first', 'f1', 'first', { orderKey: 'a2' }),
      valueChild('v-second', 'f1', 'second', { orderKey: 'a3' }),
    )

    expect((await audit()).property_cell_divergence).toMatchObject({ status: 'ok', divergentCells: 0 })
  })

  it('ignores a tombstoned field row, a deleted owner, and a field row whose definition does not resolve', async () => {
    await insertRaw(
      owner('o0', { [statusProp.name]: 'live' }),
      fieldRow('f0-dead', 'o0', statusProp.name, { orderKey: 'a0', deleted: true }),
      valueChild('v0-dead', 'f0-dead', 'dead'),
      fieldRow('f0', 'o0', statusProp.name, { orderKey: 'a1' }),
      valueChild('v0', 'f0', 'live'),
      owner('o1', { [statusProp.name]: 'cell' }),
      fieldRow('f1', 'o1', statusProp.name, { deleted: true }),
      valueChild('v1', 'f1', 'children'),
      owner('o2', { [statusProp.name]: 'cell' }, { deleted: true }),
      fieldRow('f2', 'o2', statusProp.name),
      valueChild('v2', 'f2', 'children'),
      owner('o3', {}),
      block('f3', { parentId: 'o3', content: '::((nowhere))', referenceTargetId: 'nowhere', isFieldForm: true }),
      valueChild('v3', 'f3', 'children'),
    )

    // o0 (its live field row) and o3 (the unresolved one); o1 has only a
    // tombstoned field row and o2 is deleted.
    expect((await audit()).property_cell_divergence).toMatchObject({
      status: 'ok', divergentCells: 0, ownersScanned: 2, fieldsChecked: 1, unresolvedFields: 1,
    })
  })

  it('runs in the scheduled audit, which hands it the repo', async () => {
    const rows = [
      owner('o1', { [statusProp.name]: 'stale' }),
      fieldRow('f1', 'o1', statusProp.name),
      valueChild('v1', 'f1', 'fresh'),
    ]
    await insertRaw(...rows)
    // Synced twins, so the local/server check reads converged and does not
    // sleep through its recheck.
    for (const row of rows) {
      await sharedDb.db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, blockToSyncedRowParams(row))
    }

    const { checks } = await runConsistencyAuditNow(repo, WS)

    expect(checks.property_cell_divergence).toMatchObject({ status: 'anomaly', divergentCells: 1 })
    expect(checks.property_cell_coverage.status).toBe('ok')
  })

  it('reads every owner across keyset pages', async () => {
    const owners = 501
    const rows: BlockData[] = []
    for (let i = 0; i < owners; i++) {
      const id = `o${String(i).padStart(4, '0')}`
      rows.push(owner(id, { [statusProp.name]: 'stale' }), fieldRow(`f-${id}`, id, statusProp.name),
        valueChild(`v-${id}`, `f-${id}`, 'fresh'))
    }
    await insertRaw(...rows)

    expect((await audit()).property_cell_divergence).toMatchObject({
      ownersScanned: owners, divergentCells: owners,
    })
  })

  it('waits for the registry to load before resolving field rows', async () => {
    await insertRaw(
      owner('o1', { [statusProp.name]: 'stale' }),
      fieldRow('f1', 'o1', statusProp.name),
      valueChild('v1', 'f1', 'fresh'),
    )
    // A fresh runtime has produced no snapshot yet: resolving now would read
    // every fieldId as unavailable and report the stale cell as clean.
    repo = createTestRepo({ db: sharedDb.db, user: { id: 'user-1' } }).repo
    installRuntime()
    expect(repo.propertySchemaResolverFor(WS).resolve(statusProp.name).status).not.toBe('resolved')

    // Called directly: inside the audit, the coverage check's reads give the
    // projector time to finish first.
    expect(await runPropertyCellDivergenceCheck(sharedDb.db, repo, WS, 8)).toMatchObject({
      status: 'anomaly', divergentCells: 1, unresolvedFields: 0,
    })
  })

  it('refuses rather than reading clean when the registry moves on during the wait', async () => {
    await insertRaw(
      owner('o1', { [statusProp.name]: 'stale' }),
      fieldRow('f1', 'o1', statusProp.name),
      valueChild('v1', 'f1', 'fresh'),
    )
    // Two switches: past the retained previous workspace the resolver fails
    // closed, every field row reads as unresolved, and nothing is compared.
    vi.spyOn(repo, 'whenPropertyDefinitionsReady').mockImplementation(async () => {
      repo.setActiveWorkspaceId('ws-a')
      repo.setActiveWorkspaceId('ws-b')
    })

    await expect(runPropertyCellDivergenceCheck(sharedDb.db, repo, WS, 8))
      .rejects.toThrow('registry is not loaded')
  })

  it('degrades to error alone when the registry is not loaded for the workspace', async () => {
    await insertRaw(owner('o1', { [statusProp.name]: 'a' }))
    repo.setActiveWorkspaceId('ws-elsewhere')

    const checks = await audit()

    expect(checks.property_cell_divergence).toMatchObject({
      status: 'error', error: expect.stringContaining('registry is not loaded'),
    })
    expect(checks.property_cell_coverage.status).toBe('error')
    expect(checks.property_field_row_duplicates.status).toBe('ok')
  })
})
