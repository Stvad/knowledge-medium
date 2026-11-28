// @vitest-environment happy-dom
import {afterAll, afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb.js'
import {createTestRepo} from '@/data/test/createTestRepo.js'
import {createFakeSyncServer} from '@/data/test/fakeSyncServer.js'
import {applySyncInvalidation} from '@/data/internals/syncObserver/invalidate.js'
import {ChangeScope} from '@/data/api/index.js'
import {drainStaged} from '@/data/test/syncCheckpoint.js'
import {__applyCompactedBlockOperationsForTest, __runUploadLoopForTest} from '@/services/powersync.js'
import {kernelPropertyUiExtension} from '@/components/propertyEditors/typesPropertyUi.js'
import {kernelValuePresetsExtension} from '@/components/propertyEditors/kernelValuePresets.js'
import {dailyNotesDataExtension} from '@/plugins/daily-notes/dataExtension.js'
import {diagnosticsFacet, type DiagnosticSourceContribution} from '@/plugins/diagnostics/facet.js'
import matrix, {appendMatrixMessage, checkpointId, messageNodeId, nextBatchKey, pollLoop, publishDeviceCheckpoint, startFresh, tokenKey} from './matrix-chat-client.tsx'

vi.mock('https://esm.sh/matrix-js-sdk@38.0.0?bundle', () => ({}))

const config = {workspaceId: 'workspace', baseUrl: 'https://matrix.test', roomId: '!room:matrix.test', accessToken: 'fixture', autoStart: true}
const diagnostics = matrix.find(c => c.facet.id === diagnosticsFacet.id)!.value as DiagnosticSourceContribution
const cursorKey = nextBatchKey(config)
const event = (body: string) => ({type: 'm.room.message', event_id: '$' + body, origin_server_ts: 1_700_000_000_000, content: {body}})

function replica(db: TestDb['db'], tag: string, localOnly = false) {
  let id = 0
  const {repo, cache} = createTestRepo({
    db, localOnly, extensions: [kernelPropertyUiExtension, kernelValuePresetsExtension, dailyNotesDataExtension, ...matrix], newId: () => tag + ++id, backfillSyncGate: () => () => {},
  })
  repo.setActiveWorkspaceId(config.workspaceId)
  return {db, repo, cache, downloadCursor: 0}
}
type Replica = ReturnType<typeof replica>

let senderDb: TestDb
let receiverDb: TestDb
let sender: Replica
let receiver: Replica
let server: ReturnType<typeof createFakeSyncServer>
beforeAll(async () => { [senderDb, receiverDb] = await Promise.all([createTestDb(), createTestDb()]) })
afterAll(async () => { await Promise.all([senderDb.cleanup(), receiverDb.cleanup()]) })
beforeEach(async () => {
  await Promise.all([resetTestDb(senderDb.db), resetTestDb(receiverDb.db)])
  sender = replica(senderDb.db, 'sender')
  receiver = replica(receiverDb.db, 'receiver')
  let serverClock = 1_800_000_000_000
  server = createFakeSyncServer({now: () => ++serverClock})
})
afterEach(() => { localStorage.clear() })

const upload = async (device: Replica) => {
  await __runUploadLoopForTest(device.db, {
    applyOperations: (db, ops) => __applyCompactedBlockOperationsForTest(db, ops, server),
    recordRejection: async (_db, _tx, error) => { throw error },
  }, new Map())
}
const download = async (device: Replica) => {
  device.downloadCursor = await server.deliverTo(device.db, device.downloadCursor)
  const outcome = await drainStaged(device.db)
  if (outcome) applySyncInvalidation(device.cache, device.repo.handleStore, outcome.snapshots, [])
}

const quarantineSenderUploads = () => sender.db.writeTransaction(async tx => {
  await tx.execute(`INSERT INTO ps_crud_rejected (original_id, tx_id, data, error_code, error_message, rejected_at)
                    SELECT id, tx_id, data, '42501', 'fixture rejection', 1 FROM ps_crud`)
  await tx.execute('DELETE FROM ps_crud')
})

const checkpoint = async (device: Replica) => (await device.db.getOptional<{token: string}>(
  `SELECT json_extract(properties_json, '$."matrix-checkpoint:nextBatch"') AS token
   FROM blocks WHERE id = ? AND deleted = 0`, [checkpointId(config)],
))?.token
const messages = async (device: Replica) => (await device.db.getAll<{content: string}>(
  `SELECT content FROM blocks WHERE deleted = 0 AND json_extract(properties_json, '$."matrix-event:id"') IS NOT NULL ORDER BY content`,
)).map(row => row.content)

// S0 is the tail of the initial timeline. Each appended event advances the
// stream by one, so a client choosing S1 really does miss the first event.
const response = (since: string | undefined, stream: string[]) => ({
  next_batch: 'S' + stream.length,
  rooms: {join: {[config.roomId]: {timeline: {events: since === undefined
    ? [event('initial history'), ...stream.map(event)]
    : stream.slice(Number(since.slice(1))).map(event)}}}},
})

const fresh = (reply: (since?: string) => unknown, signal = new AbortController().signal) =>
  startFresh(sender.repo, config, signal, {http: {
    authedRequest: async (_method: string, _path: string, query: {since?: string}) => reply(query.since),
  }})

const seed = async () => {
  localStorage.setItem(tokenKey(config), config.accessToken)
  await fresh(since => response(since, []))
  expect(await checkpoint(sender)).toBe('S0')
  expect(await messages(sender)).toEqual([])
  await upload(sender)
  await download(receiver)
  expect(await checkpoint(receiver)).toBe('S0')
}

const poll = async (device: Replica, replies: ((since: string | undefined) => unknown)[] = []) => {
  const controller = new AbortController()
  const requested: Array<string | undefined> = []
  const unsubscribe = diagnostics.subscribe(() => {
    if (diagnostics.getSnapshot()?.severity === 'warning') queueMicrotask(() => controller.abort())
  })
  try {
    await pollLoop(device.repo, config, controller.signal, {http: {
      authedRequest: async (_method: string, _path: string, query: {since?: string}) => {
        requested.push(query.since)
        const reply = replies.shift()
        if (reply) return reply(query.since)
        controller.abort()
        return {}
      },
    }})
    expect(replies).toHaveLength(0)
    return requested
  } finally {
    unsubscribe()
  }
}

it.each([null, 'S8', '{"nextBatch":"S8"}'])(
  'refuses resume without a graph checkpoint, including copied device state %j', async raw => {
    if (raw !== null) localStorage.setItem(cursorKey, raw)
    expect(await poll(receiver)).toEqual([])
    expect(diagnostics.getSnapshot()).toMatchObject({severity: 'warning'})
    expect(JSON.stringify(diagnostics.getSnapshot())).toMatch(/checkpoint/i)
    expect(localStorage.getItem(cursorKey)).toBe(raw)
    expect(await checkpoint(receiver)).toBeUndefined()
  },
)

it('ingests the handoff gap exactly once when another open tab completes its outstanding poll', async () => {
  await seed()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const oldTabPoll = vi.fn(async (since: string | undefined) => {
    await held
    return response(since, ['gap'])
  })
  const oldTab = poll(sender, [oldTabPoll])
  try {
    await vi.waitFor(() => expect(oldTabPoll).toHaveBeenCalledWith('S0'))
    localStorage.setItem(cursorKey, JSON.stringify({nextBatch: 'S1'}))
    expect(await poll(receiver, [since => response(since, ['gap'])])).toEqual(['S0', 'S1'])
    expect(await messages(receiver)).toEqual(['gap'])
    await upload(receiver)
    await download(sender)
  } finally {
    release()
    await oldTab
  }

  expect(await messages(sender)).toEqual(['gap'])
  await upload(sender)
  await download(receiver)
  expect(await messages(receiver)).toEqual(['gap'])
})

it.each(['pending', 'quarantined', 'dismissed rejection'] as const)(
  'resumes from the visible checkpoint with a %s sender message upload', async state => {
    await seed()
    const stream = ['in-flight']
    const assertQueue = async () => {
      const id = messageNodeId(config.workspaceId, '$in-flight', [0])
      expect(await sender.db.getOptional("SELECT 1 FROM ps_crud WHERE json_extract(data, '$.id') = ?", [id])).toBeTruthy()
      if (state !== 'pending') {
        await quarantineSenderUploads()
        expect(await sender.db.getOptional('SELECT 1 FROM ps_crud LIMIT 1')).toBeNull()
        expect(await sender.db.getOptional("SELECT 1 FROM ps_crud_rejected WHERE json_extract(data, '$.id') = ?", [id])).toBeTruthy()
        if (state === 'dismissed rejection') {
          await sender.db.execute('DELETE FROM ps_crud_rejected')
          expect(await sender.db.getOptional('SELECT 1 FROM blocks_synced WHERE id = ?', [id])).toBeNull()
        }
      }
    }
    expect(await poll(sender, [
      since => response(since, stream),
      async since => { await assertQueue(); return response(since, stream) },
    ])).toEqual(['S0', 'S1', 'S1'])
    expect(await messages(sender)).toEqual(stream)
    if (state !== 'pending') {
      await upload(sender)
      await download(receiver)
    }
    expect(await checkpoint(receiver)).toBe('S0')
    expect(await checkpoint(sender)).toBe('S0')
    expect(await messages(receiver)).toEqual([])
    localStorage.clear()
    const withGap = [...stream, 'gap']
    expect(await poll(receiver, [since => response(since, withGap)])).toEqual(['S0', 'S2'])
    expect(await messages(receiver)).toEqual(['gap', 'in-flight'])
  },
)

it.each([null, 'S8', '{"nextBatch":4}', '{"nextBatch":"  "}'])(
  'refuses to publish malformed or missing device state %j even on its original writer', async raw => {
    localStorage.setItem(tokenKey(config), config.accessToken)
    if (raw !== null) localStorage.setItem(cursorKey, raw)
    await expect(publishDeviceCheckpoint(sender.repo, config)).rejects.toThrow(/valid.*position/i)
    expect(await checkpoint(sender)).toBeUndefined()
  },
)

it.each(['pending', 'quarantined'] as const)(
  'refuses to bootstrap a copied cursor when a writer has a %s upload', async state => {
    localStorage.setItem(tokenKey(config), config.accessToken)
    localStorage.setItem(cursorKey, JSON.stringify({nextBatch: 'S1'}))
    await sender.repo.tx(tx => tx.create({
      workspaceId: config.workspaceId, parentId: null, orderKey: 'a0', content: 'waiting for upload',
    }), {scope: ChangeScope.BlockDefault})
    expect(await sender.db.getOptional('SELECT 1 FROM ps_crud LIMIT 1')).toBeTruthy()
    if (state === 'quarantined') await quarantineSenderUploads()
    await expect(publishDeviceCheckpoint(sender.repo, config)).rejects.toThrow(/uploads/i)
    expect(await checkpoint(sender)).toBeUndefined()
  },
)

it('bootstraps the original device position after uploads drain and refuses a second initialization', async () => {
  localStorage.setItem(tokenKey(config), config.accessToken)
  localStorage.setItem(cursorKey, JSON.stringify({nextBatch: 'S2'}))
  await publishDeviceCheckpoint(sender.repo, config)
  expect(await checkpoint(sender)).toBe('S2')
  await upload(sender)
  await download(receiver)
  expect(await checkpoint(receiver)).toBe('S2')
  const initialSync = vi.fn(() => ({next_batch: 'S9'}))
  await expect(fresh(initialSync)).rejects.toThrow(/already.*checkpoint/i)
  expect(initialSync).not.toHaveBeenCalled()
  await expect(publishDeviceCheckpoint(sender.repo, config)).rejects.toThrow(/already.*checkpoint/i)
  expect(await checkpoint(sender)).toBe('S2')
})

it.each(['   ', 5])('requires a nonblank position from the fresh sync (%j)', async invalid => {
  localStorage.setItem(tokenKey(config), config.accessToken)
  await expect(fresh(() => ({next_batch: invalid}))).rejects.toThrow(/invalid.*position/i)
  expect(await checkpoint(sender)).toBeUndefined()
})

it.each(['workspace', 'credential', 'abort'] as const)(
  'abandons the fresh response when %s changes during the request', async change => {
    localStorage.setItem(tokenKey(config), config.accessToken)
    const controller = new AbortController()
    const attempt = fresh(() => {
      if (change === 'workspace') sender.repo.setActiveWorkspaceId('another-workspace')
      if (change === 'credential') localStorage.setItem(tokenKey(config), 'replacement')
      if (change === 'abort') controller.abort()
      return {next_batch: 'S9'}
    }, controller.signal)
    await expect(attempt).rejects.toThrow(change === 'abort' ? /abort/i : /destination or device credential changed/i)
    expect(await checkpoint(sender)).toBeUndefined()
  },
)

it('publishes after uploaded messages arrive back from the server and skips subsequent idle polls', async () => {
  await seed()
  const stream = ['landed']
  expect(await poll(sender, [
    since => response(since, stream),
    async since => {
      expect(await checkpoint(sender)).toBe('S0')
      await upload(sender)
      return response(since, stream)
    },
    async since => {
      expect(await checkpoint(sender)).toBe('S0')
      await download(sender)
      return response(since, stream)
    },
    async () => {
      expect(await checkpoint(sender)).toBe('S1')
      await upload(sender)
      return {next_batch: 'S8'}
    },
  ])).toEqual(['S0', 'S1', 'S1', 'S1', 'S8'])
  expect(await checkpoint(sender)).toBe('S1')
  await download(receiver)
  expect(await messages(receiver)).toEqual(stream)
  expect(await checkpoint(receiver)).toBe('S1')
})

it.each(['foreign workspace', 'blank position'] as const)(
  'refuses a shared checkpoint with a %s even when device storage has a valid position', async damage => {
    await seed()
    const id = checkpointId(config)
    await receiver.db.writeTransaction(tx => damage === 'foreign workspace'
      ? tx.execute('UPDATE blocks SET workspace_id = ? WHERE id = ?', ['elsewhere', id])
      : tx.execute(`UPDATE blocks SET properties_json = json_set(properties_json, '$."matrix-checkpoint:nextBatch"', '') WHERE id = ?`, [id]))
    const rebooted = replica(receiver.db, 'rebooted')
    localStorage.setItem(cursorKey, JSON.stringify({nextBatch: 'S9'}))
    expect(await poll(rebooted)).toEqual([])
    expect(diagnostics.getSnapshot()?.detail).toMatch(/checkpoint/i)
  },
)

it('refuses an untyped row occupying the shared checkpoint ID', async () => {
  await seed()
  await receiver.db.execute(`UPDATE blocks SET properties_json = json_remove(properties_json, '$.types') WHERE id = ?`, [checkpointId(config)])
  expect(await poll(receiver)).toEqual([])
  expect(diagnostics.getSnapshot()?.detail).toMatch(/checkpoint/i)
})

it('leaves a checkpoint deleted during the poll untouched', async () => {
  await seed()
  const stream = ['landed']
  const requests = await poll(sender, [
    since => response(since, stream),
    async since => {
      await upload(sender)
      await download(sender)
      await sender.db.execute('UPDATE blocks SET deleted = 1 WHERE id = ?', [checkpointId(config)])
      return response(since, stream)
    },
  ])
  expect(requests).toEqual(['S0', 'S1'])
  expect(diagnostics.getSnapshot()?.detail).toMatch(/checkpoint/i)
  const row = await sender.db.get<{token: string}>(
    `SELECT json_extract(properties_json, '$."matrix-checkpoint:nextBatch"') AS token FROM blocks WHERE id = ? AND deleted = 1`,
    [checkpointId(config)],
  )
  expect(row.token).toBe('S0')
})

it('skips the Matrix request when the workspace changes during the checkpoint read', async () => {
  await seed()
  const load = receiver.repo.load.bind(receiver.repo)
  vi.spyOn(receiver.repo, 'load').mockImplementationOnce(async id => {
    const row = await load(id)
    receiver.repo.setActiveWorkspaceId('another-workspace')
    return row
  })
  expect(await poll(receiver)).toEqual([])
})

it('refuses an empty sync position instead of polling from the beginning', async () => {
  await seed()
  expect(await poll(receiver, [() => ({next_batch: ''})])).toEqual(['S0'])
  expect(diagnostics.getSnapshot()?.detail).toMatch(/invalid sync position/i)
  expect(await checkpoint(receiver)).toBe('S0')
})

it.each(['credential', 'workspace'])('checks the bound %s before a fresh request', async change => {
  if (change === 'workspace') {
    localStorage.setItem(tokenKey(config), config.accessToken)
    sender.repo.setActiveWorkspaceId('another-workspace')
  }
  const initialSync = vi.fn(() => ({next_batch: 'S0'}))
  await expect(fresh(initialSync)).rejects.toThrow(/credential/i)
  expect(initialSync).not.toHaveBeenCalled()
})

it('rechecks the active workspace inside the checkpoint advancement transaction', async () => {
  await seed()
  const stream = ['landed']
  await poll(sender, [
    since => response(since, stream),
    async since => {
      await upload(sender)
      await download(sender)
      const write = sender.repo.tx.bind(sender.repo)
      vi.spyOn(sender.repo, 'tx').mockImplementationOnce((fn, opts) => write(async tx => {
        const get = tx.get.bind(tx)
        vi.spyOn(tx, 'get').mockImplementationOnce(async id => {
          const data = await get(id)
          sender.repo.setActiveWorkspaceId('other-workspace')
          return data
        })
        return fn(tx)
      }, opts))
      return response(since, stream)
    },
  ])
  expect(sender.repo.activeWorkspaceId).toBe('other-workspace')
  expect(await checkpoint(sender)).toBe('S0')
})

const omitDescendantEcho = async (content: string) => {
  const rows = server.rows()
  const leaf = rows.find(row => row.content === content)
  expect(leaf).toBeDefined()
  const partial = createFakeSyncServer({now: Date.now})
  await partial.createRows(rows.filter(row => row.id !== leaf!.id))
  await partial.deliverTo(sender.db, 0)
  expect(await sender.db.getOptional('SELECT 1 FROM blocks_synced WHERE id = ?', [leaf!.parent_id])).toBeTruthy()
  expect(await sender.db.getOptional('SELECT 1 FROM blocks_synced WHERE id = ?', [leaf!.id])).toBeNull()
  return leaf!.id as string
}

it('holds the checkpoint until every message descendant has a server echo', async () => {
  await seed()
  const stream = ['- root\n  - child\n    - grandchild']
  expect(await poll(sender, [
    since => response(since, stream),
    async since => {
      await upload(sender)
      await omitDescendantEcho('grandchild')
      return response(since, stream)
    },
    async since => {
      expect(await checkpoint(sender)).toBe('S0')
      await download(sender)
      return response(since, stream)
    },
  ])).toEqual(['S0', 'S1', 'S1', 'S1'])
  expect(await checkpoint(sender)).toBe('S1')
})

it('starts a new room explicitly even while an unrelated edit is waiting to upload', async () => {
  await sender.repo.tx(tx => tx.create({
    workspaceId: config.workspaceId, parentId: null, orderKey: 'a0', content: 'unrelated pending edit',
  }), {scope: ChangeScope.BlockDefault})
  expect(await sender.db.getOptional('SELECT 1 FROM ps_crud LIMIT 1')).toBeTruthy()
  localStorage.setItem(tokenKey(config), config.accessToken)
  await fresh(since => response(since, []))
  expect(await checkpoint(sender)).toBe('S0')
})

it('a permanently local-only device resumes its own position and saves progress across reloads', async () => {
  localStorage.setItem(cursorKey, JSON.stringify({nextBatch: 'S0'}))
  const stream = ['locally ingested']
  const device = replica(sender.db, 'offline', true)
  expect(await poll(device, [since => response(since, stream)])).toEqual(['S0', 'S1'])
  expect(await messages(device)).toEqual(stream)
  expect(await checkpoint(device)).toBeUndefined()
  const rebooted = replica(device.db, 'rebooted', true)
  expect(await poll(rebooted)).toEqual(['S1'])
  expect(await checkpoint(rebooted)).toBeUndefined()
})

it('requires a server echo of prior Matrix ingest before bootstrapping from the original writer', async () => {
  localStorage.setItem(tokenKey(config), config.accessToken)
  localStorage.setItem(cursorKey, JSON.stringify({nextBatch: 'S1'}))
  await appendMatrixMessage(sender.repo, config, event('pre-upgrade'), {}, () => {})
  await upload(sender)
  expect(await sender.db.getOptional('SELECT 1 FROM ps_crud LIMIT 1')).toBeNull()
  await expect(publishDeviceCheckpoint(sender.repo, config)).rejects.toThrow()
  expect(await checkpoint(sender)).toBeUndefined()
  await download(sender)
  await publishDeviceCheckpoint(sender.repo, config)
  expect(await checkpoint(sender)).toBe('S1')
})

it('a permanently local-only device can resume a shared baseline and keeps subsequent progress local', async () => {
  await seed()
  const device = replica(receiver.db, 'local-only', true)
  localStorage.removeItem(cursorKey)
  const stream = ['new']
  expect(await poll(device, [
    since => response(since, stream),
    async since => {
      await upload(device)
      await download(device)
      return response(since, stream)
    },
  ])).toEqual(['S0', 'S1', 'S1'])
  expect(await checkpoint(device)).toBe('S0')
  expect(await poll(device)).toEqual(['S1'])
})

it.each([null, '{"nextBatch":""}'])('refuses local-only resume when neither graph nor device has a position (%j)', async raw => {
  if (raw !== null) localStorage.setItem(cursorKey, raw)
  const device = replica(sender.db, 'local-only', true)
  expect(await poll(device)).toEqual([])
  expect(diagnostics.getSnapshot()?.detail).toMatch(/checkpoint/i)
  expect(await checkpoint(device)).toBeUndefined()
})

const adoptPosition = () => {
  localStorage.setItem(tokenKey(config), config.accessToken)
  localStorage.setItem(cursorKey, JSON.stringify({nextBatch: 'S1'}))
  return publishDeviceCheckpoint(sender.repo, config)
}

it('requires the server copy of a message identified by its legacy room property', async () => {
  const prior = event('legacy')
  const id = messageNodeId(config.workspaceId, prior.event_id, [0])
  await appendMatrixMessage(sender.repo, config, prior, {}, () => {})
  await sender.db.execute(`UPDATE blocks SET properties_json =
    json_set(json_remove(properties_json, '$."matrix-event:room"'), '$."matrix:roomId"', ?) WHERE id = ?`, [config.roomId, id])
  await upload(sender)
  await expect(adoptPosition()).rejects.toThrow(/uploads|server cop/i)
  expect(await checkpoint(sender)).toBeUndefined()
})

it('can publish with an unconfirmed message belonging to another room', async () => {
  const otherRoom = {...config, roomId: '!elsewhere:matrix.test'}
  await appendMatrixMessage(sender.repo, otherRoom, event('elsewhere'), {}, () => {})
  await upload(sender)
  expect(await sender.db.getOptional('SELECT 1 FROM blocks_synced LIMIT 1')).toBeNull()
  await adoptPosition()
  expect(await checkpoint(sender)).toBe('S1')
})

it('can publish when only a deleted message child lacks an echo', async () => {
  await appendMatrixMessage(sender.repo, config, event('- root\n  - deleted leaf'), {}, () => {})
  await upload(sender)
  const leafId = await omitDescendantEcho('deleted leaf')
  await sender.db.execute('UPDATE blocks SET deleted = 1 WHERE id = ?', [leafId])
  await adoptPosition()
  expect(await checkpoint(sender)).toBe('S1')
})

it('refuses a server echo whose block id matches but whose workspace differs', async () => {
  const prior = event('prior')
  const id = messageNodeId(config.workspaceId, prior.event_id, [0])
  await appendMatrixMessage(sender.repo, config, prior, {}, () => {})
  await upload(sender)
  await server.deliverTo(sender.db, 0)
  await sender.db.execute('UPDATE blocks_synced SET workspace_id = ? WHERE id = ?', ['elsewhere', id])
  expect(await sender.db.getOptional('SELECT workspace_id FROM blocks_synced WHERE id = ?', [id]))
    .toEqual({workspace_id: 'elsewhere'})
  await expect(adoptPosition()).rejects.toThrow(/uploads|server cop/i)
  expect(await checkpoint(sender)).toBeUndefined()
})

it('ignores room metadata on other record types and messages in another workspace', async () => {
  const otherWorkspace = {...config, workspaceId: 'another-workspace'}
  await sender.repo.tx(tx => tx.create({
    workspaceId: config.workspaceId, parentId: null, orderKey: 'a0', content: 'another record',
    properties: {types: ['another-type'], 'matrix-event:room': config.roomId},
  }), {scope: ChangeScope.BlockDefault})
  sender.repo.setActiveWorkspaceId(otherWorkspace.workspaceId)
  await appendMatrixMessage(sender.repo, otherWorkspace, event('elsewhere'), {}, () => {})
  sender.repo.setActiveWorkspaceId(config.workspaceId)
  await upload(sender)
  await adoptPosition()
  expect(await checkpoint(sender)).toBe('S1')
})

it('excludes foreign-workspace children at the boundary of a message tree', async () => {
  await appendMatrixMessage(sender.repo, config, event('- root\n  - moved'), {}, () => {})
  await upload(sender)
  const leaf = await omitDescendantEcho('moved')
  await sender.db.execute('UPDATE blocks SET workspace_id = ? WHERE id = ?', ['elsewhere', leaf])
  await adoptPosition()
  expect(await checkpoint(sender)).toBe('S1')
})

it('holds the processed message identity when a local edit removes its Matrix metadata', async () => {
  await seed()
  const stream = ['edited']
  await poll(sender, [
    since => response(since, stream),
    async since => {
      const id = messageNodeId(config.workspaceId, '$edited', [0])
      await sender.db.execute("UPDATE blocks SET properties_json = '{}' WHERE id = ?", [id])
      await quarantineSenderUploads()
      await sender.db.execute('DELETE FROM ps_crud_rejected')
      expect(await sender.db.getOptional('SELECT 1 FROM blocks_synced WHERE id = ?', [id])).toBeNull()
      return response(since, stream)
    },
  ])
  expect(await checkpoint(sender)).toBe('S0')
  await upload(sender)
  await download(receiver)
  expect(await poll(receiver, [since => response(since, stream)])).toEqual(['S0', 'S1'])
  expect(await messages(receiver)).toEqual(stream)
})
