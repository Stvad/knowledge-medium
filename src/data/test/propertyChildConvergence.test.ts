// @vitest-environment node
/**
 * Two devices that set one property on one block before either has seen the
 * other end up with ONE field row once both have synced.
 *
 * No processor runs on sync apply, so whatever the two mints leave is final
 * until someone edits that property again — the case that matters is a block
 * nobody edits again (an ingested message). What makes it one row is that both
 * devices derive the same id; the server's insert-or-touch then keeps one.
 *
 * Wiring as in `concurrentEditConvergence.test.ts`: the real upload pipeline
 * into `createFakeSyncServer`, delivered back through `blocks_synced` and the
 * staging drain. The workspace row is written raw, on each device, so nothing
 * but the writes under test touches property machinery.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ChangeScope, codecs, defineProperty, type AnyPropertySchema } from '@/data/api'
import { projectedPropertyDefinitionsFacet } from '@/data/facets'
import { propertyFieldContent } from '@/data/propertyChildren'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { createFakeSyncServer, type FakeSyncServer } from '@/data/test/fakeSyncServer'
import {
  __applyCompactedBlockOperationsForTest,
  __runUploadLoopForTest,
} from '@/services/powersync'
import { applySyncInvalidation } from '@/data/internals/syncObserver/invalidate.js'
import { constMat, drainStagingWindowOnce, noKey } from '@/data/internals/syncObserver/test/harness.js'
import type { Repo } from '@/data/repo'
import type { BlockCache } from '@/data/blockCache'

const WS = '3f2b7c10-9d4e-4a61-8c2f-15b0e7a94d33'
const OWNER = '0b9d2c41-6a3e-4f58-9c71-2d4e6f8a0b13'
const STATUS_FIELD = '7e1f3a52-8c4d-4b69-a0e2-3f5a7c9e1d24'
const TAGS_FIELD = '8f2a4b63-9d5e-4c7a-b1f3-4a6c8e0f2b46'

const statusSchema = defineProperty('status', {
  codec: codecs.string, defaultValue: '', changeScope: ChangeScope.BlockDefault,
})
const tagsSchema = defineProperty('tags', {
  codec: codecs.list(codecs.string), defaultValue: [] as string[], changeScope: ChangeScope.BlockDefault,
})

interface Device {
  db: TestDb['db']
  repo: Repo
  cache: BlockCache
  cursor: number
}

const materializeDeps = {getMaterializability: constMat('copy'), getCek: noKey}

const upload = async (device: Device, server: FakeSyncServer): Promise<void> => {
  const rejections: unknown[] = []
  await __runUploadLoopForTest(device.db, {
    applyOperations: (database, ops) => __applyCompactedBlockOperationsForTest(database, ops, {
      createRows: rows => server.createRows(rows),
      applyPatches: patches => server.applyPatches(patches),
      deleteRow: id => server.deleteRow(id),
    }),
    recordRejection: async (_db, _tx, error) => { rejections.push(error) },
  }, new Map())
  expect(rejections, 'no upload may be quarantined').toEqual([])
}

const deliverAndDrain = async (device: Device, server: FakeSyncServer): Promise<void> => {
  device.cursor = await server.deliverTo(device.db, device.cursor)
  const outcome = await drainStagingWindowOnce(device.db, materializeDeps)
  if (outcome) applySyncInvalidation(device.cache, device.repo.handleStore, outcome.snapshots, [])
}

const quiesce = async (devices: readonly Device[], server: FakeSyncServer): Promise<void> => {
  for (let round = 0; round < 3; round++) {
    for (const device of devices) await upload(device, server)
    for (const device of devices) await deliverAndDrain(device, server)
  }
}

let dbA: TestDb
let dbB: TestDb
beforeAll(async () => {
  dbA = await createTestDb()
  dbB = await createTestDb()
})
afterAll(async () => {
  await dbA.cleanup()
  await dbB.cleanup()
})

const registerDefinition = (repo: Repo, fieldId: string, schema: AnyPropertySchema): void => {
  repo.setRuntimeContributions(projectedPropertyDefinitionsFacet, `def-${fieldId}`, [{
    metadata: {
      fieldId, workspaceId: WS, createdAt: 1, name: schema.name,
      changeScope: schema.changeScope, hidden: false, origin: 'user' as const,
    },
    schema,
  }], {workspaceId: WS})
}

/** Two plaintext devices on one server, both switched to property blocks, with
 *  OWNER created on A and synced to both. */
const setup = async () => {
  let serverClock = 1_800_000_000_000
  const server = createFakeSyncServer({now: () => ++serverClock})
  const mkDevice = async (db: TestDb['db'], tag: 'a' | 'b', clockStart: number): Promise<Device> => {
    await resetTestDb(db)
    await db.writeTransaction(async tx => {
      await tx.execute(
        `INSERT INTO workspaces
           (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
         VALUES (?, 'ws', 'user-a', 1, 1, 'none', NULL, 'children')`,
        [WS])
    })
    let time = clockStart
    let idCursor = 0
    // Each device its own id stream: the default is a counter, and two
    // counters would hand both devices the same "random" ids — converging by
    // accident on exactly the rows this file is about.
    const {repo, cache} = createTestRepo({
      db, user: {id: `user-${tag}`}, now: () => ++time, newId: () => `${tag}-gen-${++idCursor}`,
    })
    repo.setActiveWorkspaceId(WS)
    registerDefinition(repo, STATUS_FIELD, statusSchema)
    registerDefinition(repo, TAGS_FIELD, tagsSchema)
    return {db, repo, cache, cursor: 0}
  }
  const a = await mkDevice(dbA.db, 'a', 1_700_000_500_000)
  const b = await mkDevice(dbB.db, 'b', 1_700_000_000_000)

  await a.repo.tx(tx => tx.create({
    id: OWNER, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'message',
  }).then(() => undefined), {scope: ChangeScope.BlockDefault})
  await upload(a, server)
  for (const device of [a, b]) await deliverAndDrain(device, server)
  return {a, b, server}
}

interface Row { id: string; content: string }

const liveChildren = (device: Device, parentId: string): Promise<Row[]> => device.db.getAll<Row>(
  'SELECT id, content FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id',
  [parentId])

const fieldRows = async (device: Device, fieldId: string): Promise<Row[]> =>
  (await liveChildren(device, OWNER)).filter(row => row.content === propertyFieldContent(fieldId))

const setOn = (device: Device, write: Parameters<Repo['tx']>[0]) =>
  device.repo.tx(write, {scope: ChangeScope.BlockDefault})

describe('concurrent first writes of one property converge on one field row', () => {
  it('a scalar written with one value on both devices', async () => {
    const {a, b, server} = await setup()
    await setOn(a, tx => tx.setProperty(OWNER, statusSchema, 'done'))
    await setOn(b, tx => tx.setProperty(OWNER, statusSchema, 'done'))

    await quiesce([a, b], server)

    for (const device of [a, b]) {
      const fields = await fieldRows(device, STATUS_FIELD)
      expect(fields).toHaveLength(1)
      expect((await liveChildren(device, fields[0]!.id)).map(row => row.content)).toEqual(['done'])
    }
    expect(await fieldRows(a, STATUS_FIELD)).toEqual(await fieldRows(b, STATUS_FIELD))
  })

  it('a scalar written with different values: one value row, which every device agrees on', async () => {
    // The policy change: a divergent concurrent value no longer survives as a
    // peer. The slot is ONE row, and the server keeps the FIRST create of it
    // (insert-or-touch), while the owner's cell keeps the LAST patch. So the
    // two settle on different writers until the next local write of the
    // property on this block reconciles the children to the cell. ACCEPTED,
    // and pinned so a change to either side is seen.
    const {a, b, server} = await setup()
    await setOn(a, tx => tx.setProperty(OWNER, statusSchema, 'from-a'))
    await setOn(b, tx => tx.setProperty(OWNER, statusSchema, 'from-b'))

    await upload(a, server)
    await upload(b, server)
    await quiesce([a, b], server)

    const [fieldA] = await fieldRows(a, STATUS_FIELD)
    expect(await fieldRows(a, STATUS_FIELD)).toHaveLength(1)
    expect(await fieldRows(b, STATUS_FIELD)).toEqual([fieldA])
    const valuesA = await liveChildren(a, fieldA!.id)
    expect(valuesA.map(row => row.content)).toEqual(['from-a'])
    expect(await liveChildren(b, fieldA!.id)).toEqual(valuesA)
    for (const device of [a, b]) {
      const owner = await device.db.get<{properties_json: string}>(
        'SELECT properties_json FROM blocks WHERE id = ?', [OWNER])
      expect(JSON.parse(owner.properties_json)).toEqual({status: 'from-b'})
    }
  })

  it('a list with an equal member on both devices keeps one member row', async () => {
    const {a, b, server} = await setup()
    await setOn(a, tx => tx.setProperty(OWNER, tagsSchema, ['blue']))
    await setOn(b, tx => tx.setProperty(OWNER, tagsSchema, ['blue']))

    await quiesce([a, b], server)

    for (const device of [a, b]) {
      const fields = await fieldRows(device, TAGS_FIELD)
      expect(fields).toHaveLength(1)
      expect((await liveChildren(device, fields[0]!.id)).map(row => row.content)).toEqual(['blue'])
    }
  })

  it('a list with different members on each device keeps both, under one field row', async () => {
    const {a, b, server} = await setup()
    await setOn(a, tx => tx.setProperty(OWNER, tagsSchema, ['blue']))
    await setOn(b, tx => tx.setProperty(OWNER, tagsSchema, ['red']))

    await quiesce([a, b], server)

    for (const device of [a, b]) {
      const fields = await fieldRows(device, TAGS_FIELD)
      expect(fields).toHaveLength(1)
      expect((await liveChildren(device, fields[0]!.id)).map(row => row.content).sort())
        .toEqual(['blue', 'red'])
    }
  })
})
