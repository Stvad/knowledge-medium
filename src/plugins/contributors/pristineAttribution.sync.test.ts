// @vitest-environment node
/**
 * Two devices mint the same deterministic media block offline, each in its own
 * tx. The server keeps the first upload, so whatever the first device attributed
 * has to travel with it, references included: this drives the real upload and
 * sync path to prove the converged row agrees with itself.
 */
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import {ChangeScope} from '@/data/api'
import type {BlockCache} from '@/data/blockCache'
import {PAGE_TYPE} from '@/data/blockTypes'
import {applySyncInvalidation} from '@/data/internals/syncObserver/invalidate.js'
import {constMat, drainStagingWindowOnce, noKey} from '@/data/internals/syncObserver/test/harness.js'
import {typesProp} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {createFakeSyncServer, type FakeSyncServer} from '@/data/test/fakeSyncServer'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {MEDIA_TYPE} from '@/plugins/attachments/mediaBlock'
import {referencesDataExtension} from '@/plugins/references/dataExtension'
import {
  __applyCompactedBlockOperationsForTest,
  __runUploadLoopForTest,
} from '@/services/powersync'
import {contributorsDataExtension} from './dataExtension'
import {attributionCreatorsProp, CONTRIBUTOR_TYPE, contributorKindProp} from './schema'


const WS = 'workspace'
const ASSET = 'a1f4c7e2-0000-5000-8000-000000000001'
const ATLAS = 'atlas'
const SCOUT = 'scout'
const HUMAN = null
const opts = {scope: ChangeScope.BlockDefault}

interface Device {
  db: TestDb['db']
  repo: Repo
  cache: BlockCache
  cursor: number
}

let dbA: TestDb
let dbB: TestDb
let server: FakeSyncServer
let a: Device
let b: Device
beforeAll(async () => {
  dbA = await createTestDb()
  dbB = await createTestDb()
})
afterAll(async () => {
  await dbA.cleanup()
  await dbB.cleanup()
})

const upload = async (device: Device): Promise<void> => {
  const rejections: unknown[] = []
  await __runUploadLoopForTest(device.db, {
    applyOperations: (database, ops) => __applyCompactedBlockOperationsForTest(database, ops, {
      createRows: rows => server.createRows(rows),
      applyPatches: patches => server.applyPatches(patches),
      deleteRow: id => server.deleteRow(id),
    }),
    recordRejection: async (_db, _tx, error) => { rejections.push(error) },
  }, new Map())
  expect(rejections).toEqual([])
}

const deliver = async (device: Device): Promise<void> => {
  device.cursor = await server.deliverTo(device.db, device.cursor)
  const outcome = await drainStagingWindowOnce(device.db, {getMaterializability: constMat('copy'), getCek: noKey})
  if (outcome) applySyncInvalidation(device.cache, device.repo.handleStore, outcome.snapshots, [])
}

const device = (db: TestDb['db'], tag: string, clockStart: number): Device => {
  let time = clockStart
  let ids = 0
  const {repo, cache} = createTestRepo({
    db,
    user: {id: `user-${tag}`},
    now: () => ++time,
    newId: () => `${tag}-gen-${++ids}`,
    extensions: [contributorsDataExtension, referencesDataExtension],
  })
  repo.setActiveWorkspaceId(WS)
  return {db, repo, cache, cursor: 0}
}

const setup = async (storage: 'cells' | 'children') => {
  await resetTestDb(dbA.db)
  await resetTestDb(dbB.db)
  let serverClock = 1_800_000_000_000
  server = createFakeSyncServer({now: () => ++serverClock})
  if (storage === 'children') {
    for (const {db} of [dbA, dbB]) {
      await db.execute(`INSERT INTO workspaces
        (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
        VALUES (?, 'Test', 'vlad', 1, 1, 'none', NULL, 'children')`, [WS])
    }
  }
  a = device(dbA.db, 'a', 1_700_000_500_000)
  b = device(dbB.db, 'b', 1_700_000_000_000)
  await a.repo.withTxContext({contributorId: null}).tx(async tx => {
    for (const id of [ATLAS, SCOUT]) {
      await tx.create({id, workspaceId: WS, parentId: null, orderKey: 'a0', content: id,
        properties: {[typesProp.name]: [PAGE_TYPE, CONTRIBUTOR_TYPE], [contributorKindProp.name]: 'agent'}})
    }
  }, opts)
  await a.repo.awaitProcessors()
  await upload(a)
  await deliver(b)
}

const capture = async (on: Device, contributor: string | null): Promise<void> => {
  const repo = contributor ? on.repo.withTxContext({contributorId: contributor, contributorSource: 'agent'}) : on.repo
  await repo.tx(async tx => {
    await tx.create({id: ASSET, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'shot.png'}, {systemMint: true})
    await tx.setProperty(ASSET, typesProp, [MEDIA_TYPE])
  }, opts)
  await on.repo.awaitProcessors()
}

const settle = async () => {
  for (let round = 0; round < 3; round++) {
    for (const on of [a, b]) await upload(on)
    for (const on of [a, b]) {
      await deliver(on)
      await on.repo.awaitProcessors()
    }
  }
}

const attribution = async (on: Device) => {
  const row = await on.db.getOptional<{properties_json: string, references_json: string, updated_at: number}>(
    'SELECT properties_json, references_json, updated_at FROM blocks WHERE id = ?', [ASSET],
  )
  const references = JSON.parse(row!.references_json) as Array<{id: string, sourceField?: string}>
  return {
    creators: JSON.parse(row!.properties_json)[attributionCreatorsProp.name] ?? [],
    referenced: references.filter(ref => ref.sourceField === attributionCreatorsProp.name).map(ref => ref.id),
    pristine: row!.updated_at === 0,
  }
}

describe.each(['cells', 'children'] as const)('a pristine media block minted on two devices, stored in %s', storage => {
  it('stays pristine on one device once the processors have run, with its references in place', async () => {
    await setup(storage)
    await capture(a, ATLAS)
    expect(await attribution(a)).toEqual({creators: [ATLAS], referenced: [ATLAS], pristine: true})
  })

  it.each([
    ['an agent, then a person', ATLAS, HUMAN, [ATLAS]],
    ['a person, then an agent', HUMAN, ATLAS, []],
    ['two agents', ATLAS, SCOUT, [ATLAS]],
    ['the same two agents, the other way', SCOUT, ATLAS, [SCOUT]],
  ])('converges on the first upload\'s attribution and its references: %s', async (_, first, second, expected) => {
    await setup(storage)
    await capture(a, first)
    await capture(b, second)
    await upload(a)
    await upload(b)
    await settle()
    for (const on of [a, b]) {
      expect(await attribution(on)).toEqual({creators: expected, referenced: expected, pristine: true})
    }
  })
})
