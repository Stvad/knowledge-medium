// @vitest-environment node
/**
 * Two devices that create one block at a deterministic id WITH its properties
 * (an ingested chat message) end up with ONE set of property machinery rows
 * once both have synced — and a first write to a block that already existed on
 * the writing device does not meet a peer's tombstone at a derived id.
 *
 * No processor runs on sync apply, so whatever the mints leave is final until
 * someone edits that property again. Machinery ids are derived only under a
 * parent created in the same transaction (`mintPropertyChildRow`), so a row
 * both devices minted collides along with the block and keeps the first
 * create; a row only the losing device minted lands under the winner's block.
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
import type { MaterializeDeps } from '@/data/internals/syncObserver/materialize.js'
import { referenceTargetLookupsVia } from '@/data/internals/referenceTargetLookups'
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

/** As production wires it (`repo.ts`): without the lookups an arrival is never
 *  stamped `is_field_form`, so a device would not recognize a synced field row
 *  and mint a second one. */
const materializeDeps: MaterializeDeps = {
  getMaterializability: constMat('copy'),
  getCek: noKey,
  referenceTargetLookups: tx => referenceTargetLookupsVia(tx),
}

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

/** `first`'s upload, with its create batch split after `k` rows (parents
 *  first) and `peer`'s whole upload landing between the two halves — what
 *  `apply_block_creates`' 500-row batching allows on a long catch-up. */
const uploadSplit = async (first: Device, peer: Device, server: FakeSyncServer, k: number): Promise<void> => {
  let split = false
  await __runUploadLoopForTest(first.db, {
    applyOperations: (database, ops) => __applyCompactedBlockOperationsForTest(database, ops, {
      createRows: async rows => {
        if (split) return server.createRows(rows)
        split = true
        const depth = (row: Record<string, unknown>): number => {
          let parent = row.parent_id as string | null
          let d = 0
          while (parent) {
            d += 1
            parent = (rows.find(other => other.id === parent)?.parent_id ?? null) as string | null
          }
          return d
        }
        const ordered = [...rows].sort((x, y) => depth(x) - depth(y))
        await server.createRows(ordered.slice(0, k))
        await upload(peer, server)
        await server.createRows(ordered.slice(k))
      },
      applyPatches: patches => server.applyPatches(patches),
      deleteRow: id => server.deleteRow(id),
    }),
    recordRejection: async (_db, _tx, error) => { throw error },
  }, new Map())
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

/** OWNER, created on `device` — with `properties`, in the same tx, when given:
 *  the shape ingest writes. */
const createOwner = (device: Device, properties?: Record<string, unknown>) => device.repo.tx(
  tx => tx.create({id: OWNER, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'message', properties})
    .then(() => undefined),
  {scope: ChangeScope.BlockDefault})

/** Two plaintext devices on one server, both switched to property blocks —
 *  with OWNER created on A and synced to both when `ownerExists`. */
const setup = async ({ownerExists}: {ownerExists: boolean}) => {
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

  if (ownerExists) {
    await createOwner(a)
    await upload(a, server)
    for (const device of [a, b]) await deliverAndDrain(device, server)
  }
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

const cellOf = async (device: Device): Promise<unknown> => JSON.parse((await device.db.get<{properties_json: string}>(
  'SELECT properties_json FROM blocks WHERE id = ?', [OWNER])).properties_json)

/** What a device holds for the property: its cell and its live value rows. */
const stateOf = async (device: Device, fieldId: string) => {
  const fields = await fieldRows(device, fieldId)
  const values: string[] = []
  for (const field of fields) values.push(...(await liveChildren(device, field.id)).map(row => row.content))
  return {cell: await cellOf(device), fieldRows: fields.length, values}
}

describe('two devices creating one block with its properties converge on one set of rows', () => {
  it('a scalar with one value on both', async () => {
    const {a, b, server} = await setup({ownerExists: false})
    await createOwner(a, {status: 'done'})
    await createOwner(b, {status: 'done'})

    await quiesce([a, b], server)

    expect(await stateOf(a, STATUS_FIELD)).toEqual({cell: {status: 'done'}, fieldRows: 1, values: ['done']})
    expect(await fieldRows(b, STATUS_FIELD)).toEqual(await fieldRows(a, STATUS_FIELD))
  })

  it('a scalar with different values keeps both as peers under one field row', async () => {
    // A value is keyed by what it is, so neither device's value can be the one
    // the server drops; the cell is the first create's.
    const {a, b, server} = await setup({ownerExists: false})
    await createOwner(a, {status: 'from-a'})
    await createOwner(b, {status: 'from-b'})

    await upload(a, server)
    await quiesce([a, b], server)

    for (const device of [a, b]) {
      const state = await stateOf(device, STATUS_FIELD)
      expect({...state, values: state.values.sort()})
        .toEqual({cell: {status: 'from-a'}, fieldRows: 1, values: ['from-a', 'from-b']})
    }
  })

  it('a list with equal members keeps one row per member', async () => {
    const {a, b, server} = await setup({ownerExists: false})
    await createOwner(a, {tags: ['blue', 'blue']})
    await createOwner(b, {tags: ['blue', 'blue']})

    await quiesce([a, b], server)

    for (const device of [a, b]) {
      expect(await stateOf(device, TAGS_FIELD))
        .toEqual({cell: {tags: ['blue', 'blue']}, fieldRows: 1, values: ['blue', 'blue']})
    }
  })

  it('a member only the losing create carried lands under the winning block', async () => {
    // ACCEPTED (`mintPropertyChildRow`): the cell keeps the first create's list
    // until the property is next edited.
    const {a, b, server} = await setup({ownerExists: false})
    await createOwner(a, {tags: ['blue', 'red']})
    await createOwner(b, {tags: ['blue', 'green']})

    await upload(a, server)
    await quiesce([a, b], server)

    for (const device of [a, b]) {
      const state = await stateOf(device, TAGS_FIELD)
      expect({...state, values: state.values.sort()})
        .toEqual({cell: {tags: ['blue', 'red']}, fieldRows: 1, values: ['blue', 'green', 'red']})
    }
  })
})

describe('an upload split between a block and its value rows keeps every value', () => {
  // k = 1: the block alone in the first batch; k = 2: the block and its field
  // row, the value row after the peer's upload.
  for (const k of [1, 2]) {
    it(`divergent scalars, split after ${k}`, async () => {
      const {a, b, server} = await setup({ownerExists: false})
      await createOwner(a, {status: 'from-a'})
      await createOwner(b, {status: 'from-b'})

      await uploadSplit(a, b, server, k)
      await quiesce([a, b], server)

      for (const device of [a, b]) {
        expect((await stateOf(device, STATUS_FIELD)).values.sort()).toEqual(['from-a', 'from-b'])
      }
    })

    it(`a scalar re-set in the transaction that created the block, split after ${k}`, async () => {
      const {a, b, server} = await setup({ownerExists: false})
      for (const [device, value] of [[a, 'from-a'], [b, 'from-b']] as const) {
        await setOn(device, async tx => {
          await tx.create({
            id: OWNER, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'message',
            properties: {status: 'new'},
          })
          await tx.setProperty(OWNER, statusSchema, value)
        })
      }

      await uploadSplit(a, b, server, k)
      await quiesce([a, b], server)

      for (const device of [a, b]) {
        expect((await stateOf(device, STATUS_FIELD)).values.sort()).toEqual(['from-a', 'from-b'])
      }
    })
  }
})

describe('a property set on a block that already existed', () => {
  it('lands when a peer set and removed it while this device was offline', async () => {
    // A derived id here would meet A's tombstone, which the server keeps over
    // B's create — leaving B's value in the cell only.
    const {a, b, server} = await setup({ownerExists: true})
    await setOn(a, tx => tx.setProperty(OWNER, statusSchema, 'done'))
    await setOn(a, tx => tx.unsetProperty(OWNER, statusSchema))
    await upload(a, server)
    await setOn(b, tx => tx.setProperty(OWNER, statusSchema, 'wip'))

    await quiesce([a, b], server)

    for (const device of [a, b]) {
      expect(await stateOf(device, STATUS_FIELD)).toEqual({cell: {status: 'wip'}, fieldRows: 1, values: ['wip']})
    }
  })

  it('a re-added list member lands when a peer added and removed it offline', async () => {
    const {a, b, server} = await setup({ownerExists: true})
    await setOn(a, tx => tx.setProperty(OWNER, tagsSchema, ['blue']))
    await quiesce([a, b], server)
    await setOn(a, tx => tx.setProperty(OWNER, tagsSchema, ['blue', 'red']))
    await setOn(a, tx => tx.setProperty(OWNER, tagsSchema, ['blue']))
    await upload(a, server)
    await setOn(b, tx => tx.setProperty(OWNER, tagsSchema, ['blue', 'red']))

    await quiesce([a, b], server)

    for (const device of [a, b]) {
      const state = await stateOf(device, TAGS_FIELD)
      expect(state.cell).toEqual({tags: ['blue', 'red']})
      expect(state.values.sort()).toEqual(['blue', 'red'])
    }
  })

  it('RESIDUAL: two offline first writes still make two field rows until a local write folds them', async () => {
    // Pinned so the residual is visible; ids are random here on purpose.
    const {a, b, server} = await setup({ownerExists: true})
    await setOn(a, tx => tx.setProperty(OWNER, statusSchema, 'done'))
    await setOn(b, tx => tx.setProperty(OWNER, statusSchema, 'done'))

    await quiesce([a, b], server)

    for (const device of [a, b]) expect(await fieldRows(device, STATUS_FIELD)).toHaveLength(2)
  })
})
