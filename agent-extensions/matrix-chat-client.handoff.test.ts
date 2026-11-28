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
import matrix, {appendMatrixMessage, checkpointId, messageNodeId, nextBatchKey, pollLoop, startFresh, tokenKey} from './matrix-chat-client.tsx'

vi.mock('https://esm.sh/matrix-js-sdk@38.0.0?bundle', () => ({}))

const config = {workspaceId: 'workspace', baseUrl: 'https://matrix.test', roomId: '!room:matrix.test', accessToken: 'fixture', autoStart: true}
const diagnostics = matrix.find(c => c.facet.id === diagnosticsFacet.id)!.value as DiagnosticSourceContribution
const cursorKey = nextBatchKey(config)
const event = (body: string) => ({type: 'm.room.message', event_id: '$' + body, origin_server_ts: 1_700_000_000_000, content: {body}})

function replica(db: TestDb['db'], tag: string) {
  let id = 0
  let caughtUp = false
  const {repo, cache} = createTestRepo({
    db, extensions: [kernelPropertyUiExtension, kernelValuePresetsExtension, dailyNotesDataExtension, ...matrix], newId: () => tag + ++id,
    backfillSyncGate: ready => { if (caughtUp) ready(); return () => {} },
  })
  repo.setActiveWorkspaceId(config.workspaceId)
  caughtUp = true
  return {db, repo, cache, downloadCursor: 0, setCaughtUp: (value: boolean) => { caughtUp = value }}
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
  localStorage.setItem(tokenKey(config), config.accessToken)
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

const fresh = (device: Replica, reply: (since?: string) => unknown, signal = new AbortController().signal) =>
  startFresh(device.repo, config, signal, {http: {
    authedRequest: async (_method: string, _path: string, query: {since?: string}) => reply(query.since),
  }})

const seed = async () => {
  await fresh(sender, since => response(since, []))
  expect(await poll(sender, [since => response(since, [])])).toEqual(['S0', 'S0'])
  expect(await checkpoint(sender)).toBe('S0')
  expect(await messages(sender)).toEqual([])
  await upload(sender)
  localStorage.removeItem(cursorKey)
  await download(receiver)
  expect(await checkpoint(receiver)).toBe('S0')
}

const poll = async (device: Replica, replies: ((since: string | undefined) => unknown)[] = [], stopOnWarning = true) => {
  const controller = new AbortController()
  const requested: Array<string | undefined> = []
  const unsubscribe = diagnostics.subscribe(() => {
    if (stopOnWarning && diagnostics.getSnapshot()?.severity === 'warning') queueMicrotask(() => controller.abort())
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

const deviceCursor = () => JSON.parse(localStorage.getItem(cursorKey) ?? 'null')?.nextBatch
const storeCursor = (value: string) => localStorage.setItem(cursorKey, JSON.stringify({nextBatch: value}))

it.each([null, 'S8', '{"nextBatch":4}', '{"nextBatch":"  "}'])(
  'refuses missing or malformed copied position %j before requesting a timeline', async raw => {
    if (raw !== null) localStorage.setItem(cursorKey, raw)
    expect(await poll(receiver)).toEqual([])
    expect(diagnostics.getSnapshot()).toMatchObject({severity: 'warning', detail: expect.stringMatching(/checkpoint/i)})
    expect(localStorage.getItem(cursorKey)).toBe(raw)
    expect(await checkpoint(receiver)).toBeUndefined()
  },
)

it('resumes from the device’s own cursor ahead of a visible shared checkpoint', async () => {
  await seed()
  storeCursor('S1')
  expect(await poll(receiver, [since => response(since, ['seen', 'new'])])).toEqual(['S1', 'S2'])
  expect(await messages(receiver)).toEqual(['new'])
})

it('creates the missing shared checkpoint on the first drained idle poll, then skips idle writes', async () => {
  storeCursor('S2')
  expect(await poll(sender, [
    () => ({next_batch: 'S3'}),
    async () => {
      expect(await checkpoint(sender)).toBe('S3')
      await upload(sender)
      return {next_batch: 'S4'}
    },
  ])).toEqual(['S2', 'S3', 'S4'])
  expect(deviceCursor()).toBe('S4')
  expect(await checkpoint(sender)).toBe('S3')
  expect(await sender.db.getOptional('SELECT 1 FROM ps_crud LIMIT 1')).toBeNull()
})

it('refuses Start fresh before the checkpoint downloads and recovers both gap messages exactly once', async () => {
  await fresh(sender, () => ({next_batch: 'S0'}))
  await poll(sender, [() => ({next_batch: 'S0'})])
  await upload(sender)
  localStorage.removeItem(cursorKey)
  receiver.setCaughtUp(false)
  expect(await checkpoint(receiver)).toBeUndefined()
  expect(await receiver.repo.workspaceViewGap(config.workspaceId)).not.toBeNull()
  const stream = ['first gap', 'second gap']
  const initialSync = vi.fn((since?: string) => response(since, stream))
  await expect(fresh(receiver, initialSync)).rejects.toThrow(/sync/i)
  expect(initialSync).not.toHaveBeenCalled()
  expect(deviceCursor()).toBeUndefined()
  expect(await poll(receiver)).toEqual([])
  expect(diagnostics.getSnapshot()?.summary).toMatch(/waiting for sync/i)
  await download(receiver)
  receiver.setCaughtUp(true)
  expect(await checkpoint(receiver)).toBe('S0')
  stream.push('later')
  expect(await poll(receiver, [
    since => response(since, stream),
    async since => { await upload(receiver); return response(since, stream) },
  ])).toEqual(['S0', 'S3', 'S3'])
  await upload(receiver)
  await download(sender)
  expect(await checkpoint(sender)).toBe('S3')
  expect(await messages(sender)).toEqual(['first gap', 'later', 'second gap'])
})

const historicalMessage = async (deleted: boolean) => {
  const prior = event('prior')
  await appendMatrixMessage(receiver.repo, config, prior, {}, () => {})
  if (deleted) await receiver.db.execute('UPDATE blocks SET deleted = 1 WHERE id = ?', [messageNodeId(config.workspaceId, prior.event_id, [0])])
}
it.each(['live', 'deleted'])('refuses Start fresh before the request for a room with a %s message', async state => {
  await historicalMessage(state === 'deleted')
  const initialSync = vi.fn(() => ({next_batch: 'S9'}))
  await expect(fresh(receiver, initialSync)).rejects.toThrow(/message|ingest/i)
  expect(initialSync).not.toHaveBeenCalled()
  expect(deviceCursor()).toBeUndefined()
})

// Install the change after the transport returns, at entry to the repo write.
// Even a second preflight immediately before calling repo.tx sees the old view.
it.each(['view gap', 'live message', 'deleted message'])('rechecks %s inside the Start fresh transaction', async change => {
  const write = receiver.repo.tx.bind(receiver.repo)
  const sync = vi.fn(() => {
    vi.spyOn(receiver.repo, 'tx').mockImplementationOnce(async (work, options) => {
      if (change === 'view gap') receiver.setCaughtUp(false)
      else await historicalMessage(change === 'deleted message')
      return write(work, options)
    })
    return {next_batch: 'S9'}
  })
  await expect(fresh(receiver, sync)).rejects.toThrow(change === 'view gap' ? /sync/i : /message|ingest/i)
  expect(sync).toHaveBeenCalledOnce()
  expect(deviceCursor()).toBeUndefined()
  expect(await checkpoint(receiver)).toBeUndefined()
})

it.each(['device', 'shared'])('refuses Start fresh before fetching when the %s position exists', async position => {
  if (position === 'shared') await seed()
  else storeCursor('S1')
  const initialSync = vi.fn(() => ({next_batch: 'S9'}))
  await expect(fresh(receiver, initialSync)).rejects.toThrow(/position|checkpoint/i)
  expect(initialSync).not.toHaveBeenCalled()
})

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
    expect(await poll(receiver, [since => response(since, ['gap'])])).toEqual(['S0', 'S1'])
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

it('hands off while a sender upload is pending, from the last visible shared position', async () => {
  await seed()
  const stream = ['in-flight']
  await poll(sender, [since => response(since, stream)])
  expect(deviceCursor()).toBe('S1')
  expect(await sender.db.getOptional("SELECT 1 FROM ps_crud WHERE json_extract(data, '$.id') = ?", [
    messageNodeId(config.workspaceId, '$in-flight', [0]),
  ])).toBeTruthy()
  expect(await checkpoint(sender)).toBe('S0')
  expect(await messages(receiver)).toEqual([])
  localStorage.removeItem(cursorKey)
  stream.push('gap')
  expect(await poll(receiver, [since => response(since, stream)])).toEqual(['S0', 'S2'])
  expect(await messages(receiver)).toEqual(['gap', 'in-flight'])
})

it.each(['pending', 'rejected'])('checks the %s upload queue inside the checkpoint transaction', async state => {
  storeCursor('S2')
  const write = sender.repo.tx.bind(sender.repo)
  const inject = vi.fn(async () => {
    await write(tx => tx.create({workspaceId: config.workspaceId, parentId: null, orderKey: 'a0', content: 'late upload'}), {scope: ChangeScope.BlockDefault})
    if (state === 'rejected') await quarantineSenderUploads()
  })
  await poll(sender, [() => {
    vi.spyOn(sender.repo, 'tx').mockImplementationOnce(async (fn, opts) => {
      await inject()
      return write(fn, opts)
    })
    return {next_batch: 'S3'}
  }])
  expect(inject).toHaveBeenCalledOnce()
  expect(await checkpoint(sender)).toBeUndefined()
  expect(deviceCursor()).toBe('S3')
})

it('reports held advancement after three polls, keeps ingesting, and clears the warning when uploads drain', async () => {
  await seed()
  const stream = ['first']
  const held = () => diagnostics.getSnapshot()?.summary === 'Matrix checkpoint held'
  await poll(sender, [
    since => response(since, stream),
    async since => {
      expect(held()).toBe(false)
      await quarantineSenderUploads()
      stream.push('second')
      return response(since, stream)
    },
    since => {
      expect(held()).toBe(false)
      return response(since, stream)
    },
    async () => {
      const counts = await sender.db.get<{pending: number; rejected: number}>(
        'SELECT (SELECT count(*) FROM ps_crud) AS pending, (SELECT count(*) FROM ps_crud_rejected) AS rejected',
      )
      expect(counts.pending).toBeGreaterThan(0)
      expect(counts.rejected).toBeGreaterThan(0)
      expect(diagnostics.getSnapshot()).toMatchObject({severity: 'warning', summary: 'Matrix checkpoint held',
        detail: expect.stringContaining('Pending uploads: ' + counts.pending + '. Rejected uploads: ' + counts.rejected)})
      expect(await messages(sender)).toEqual(stream)
      expect(await checkpoint(sender)).toBe('S0')
      expect(deviceCursor()).toBe('S2')
      await sender.db.writeTransaction(async tx => {
        await tx.execute('INSERT INTO ps_crud (id, tx_id, data) SELECT original_id, tx_id, data FROM ps_crud_rejected')
        await tx.execute('DELETE FROM ps_crud_rejected')
      })
      await upload(sender)
      return {next_batch: 'S3'}
    },
    async () => {
      expect(held()).toBe(false)
      expect(await checkpoint(sender)).toBe('S3')
      await upload(sender)
      return {next_batch: 'S4'}
    },
  ], false)
  expect(await checkpoint(sender)).toBe('S3')
  expect(deviceCursor()).toBe('S4')
  await download(receiver)
  expect(await messages(receiver)).toEqual(stream)
})

it('explains how to restore a deleted shared checkpoint when the device has no position', async () => {
  await seed()
  await receiver.db.execute('UPDATE blocks SET deleted = 1 WHERE id = ?', [checkpointId(config)])
  expect(await poll(receiver)).toEqual([])
  expect(diagnostics.getSnapshot()?.detail).toMatch(/undelete the Matrix room checkpoint block/i)
  const initialSync = vi.fn(() => ({next_batch: 'S9'}))
  await expect(fresh(receiver, initialSync)).rejects.toThrow(/undelete the Matrix room checkpoint block/i)
  expect(initialSync).not.toHaveBeenCalled()

  storeCursor('S1')
  expect(await poll(receiver, [() => ({next_batch: 'S2'})])).toEqual(['S1'])
  expect(diagnostics.getSnapshot()?.detail).toMatch(/undelete the Matrix room checkpoint block/i)
  expect(await checkpoint(receiver)).toBeUndefined()
})

it.each(['   ', 5])('requires a nonblank position from the fresh sync (%j)', async invalid => {
  await expect(fresh(sender, () => ({next_batch: invalid}))).rejects.toThrow(/invalid.*position/i)
  expect(deviceCursor()).toBeUndefined()
})

it.each(['workspace', 'credential', 'abort'] as const)(
  'abandons the fresh response when %s changes during the request', async change => {
    const controller = new AbortController()
    const attempt = fresh(sender, () => {
      if (change === 'workspace') sender.repo.setActiveWorkspaceId('another-workspace')
      if (change === 'credential') localStorage.setItem(tokenKey(config), 'replacement')
      if (change === 'abort') controller.abort()
      return {next_batch: 'S9'}
    }, controller.signal)
    await expect(attempt).rejects.toThrow(change === 'abort' ? /abort/i : /destination or device credential changed/i)
    expect(deviceCursor()).toBeUndefined()
  },
)

it('refuses an empty sync position instead of polling from the beginning', async () => {
  await seed()
  expect(await poll(receiver, [() => ({next_batch: ''})])).toEqual(['S0'])
  expect(diagnostics.getSnapshot()?.detail).toMatch(/invalid sync position/i)
  expect(await checkpoint(receiver)).toBe('S0')
})

it('allows a genuinely new room with unrelated live and deleted rows in the graph', async () => {
  for (const deleted of [false, true]) {
    for (const [workspace, room, type] of [
      ['elsewhere', config.roomId, 'matrix-message'], [config.workspaceId, '!elsewhere', 'matrix-message'],
      [config.workspaceId, config.roomId, 'page'],
    ]) {
      receiver.repo.setActiveWorkspaceId(workspace)
      const id = await receiver.repo.tx(tx => tx.create({
        workspaceId: workspace, parentId: null, orderKey: 'a0', content: 'unrelated',
        properties: {types: [type], 'matrix-event:room': room},
      }), {scope: ChangeScope.BlockDefault})
      if (deleted) await receiver.db.execute('UPDATE blocks SET deleted = 1 WHERE id = ?', [id])
    }
  }
  await fresh(receiver, () => ({next_batch: 'S9'}))
  expect(deviceCursor()).toBe('S9')
  expect(await checkpoint(receiver)).toBeUndefined()
})

it('refuses a malformed shared position on a device without a cursor', async () => {
  await seed()
  await receiver.db.execute(`UPDATE blocks SET properties_json = json_set(properties_json, '$."matrix-checkpoint:nextBatch"', ' ') WHERE id = ?`, [checkpointId(config)])
  expect(await poll(receiver)).toEqual([])
  expect(diagnostics.getSnapshot()?.detail).toMatch(/position/i)
})

it.each(['workspace', 'credential'])('refuses a fresh request with the wrong %s binding', async change => {
  if (change === 'workspace') receiver.repo.setActiveWorkspaceId('another-workspace')
  else localStorage.removeItem(tokenKey(config))
  const initialSync = vi.fn(() => ({next_batch: 'S0'}))
  await expect(fresh(receiver, initialSync)).rejects.toThrow(/credential/i)
  expect(initialSync).not.toHaveBeenCalled()
})

it('skips the Matrix request when the workspace changes during the checkpoint read', async () => {
  await seed()
  const read = receiver.db.getOptional.bind(receiver.db)
  const request = vi.spyOn(receiver.db, 'getOptional').mockImplementationOnce(async <T>(...args: Parameters<typeof read>) => {
    const row = await read<T>(...args)
    receiver.repo.setActiveWorkspaceId('another-workspace')
    return row
  })
  try { expect(await poll(receiver)).toEqual([]) } finally { request.mockRestore() }
})

it('waits for the first completed download even when the connected workspace view gap is clear', async () => {
  const status = receiver.db.currentStatus
  const connected = vi.spyOn(status, 'connected', 'get').mockReturnValue(true)
  const synced = vi.spyOn(status, 'hasSynced', 'get')
  try {
    expect(receiver.repo.lastSyncedAt).toBeUndefined()
    expect(status.hasSynced).toBeFalsy()
    expect(await receiver.repo.workspaceViewGap(config.workspaceId)).toBeNull()
    const firstTimeline = vi.fn(() => ({next_batch: 'S9'}))
    await expect(fresh(receiver, firstTimeline)).rejects.toThrow(/sync/i)
    expect(firstTimeline).not.toHaveBeenCalled()
    expect(await poll(receiver)).toEqual([])
    expect(diagnostics.getSnapshot()?.summary).toMatch(/waiting for sync/i)
    synced.mockReturnValue(true)
    await fresh(receiver, firstTimeline)
    expect(deviceCursor()).toBe('S9')
  } finally {
    synced.mockRestore()
    connected.mockRestore()
  }
})

it('rolls back checkpoint advancement when the workspace switches inside its transaction', async () => {
  storeCursor('S1')
  const write = receiver.repo.tx.bind(receiver.repo)
  expect(await poll(receiver, [() => {
    vi.spyOn(receiver.repo, 'tx').mockImplementationOnce((fn, opts) => write(async tx => {
      const create = tx.createOrGet.bind(tx)
      vi.spyOn(tx, 'createOrGet').mockImplementationOnce(async (...args) => {
        const result = await create(...args)
        expect(result.inserted).toBe(true)
        receiver.repo.setActiveWorkspaceId('another-workspace')
        return result
      })
      return fn(tx)
    }, opts))
    return {next_batch: 'S2'}
  }])).toEqual(['S1'])
  expect(receiver.repo.activeWorkspaceId).toBe('another-workspace')
  expect(await checkpoint(receiver)).toBeUndefined()
  expect(await receiver.db.getOptional('SELECT 1 FROM ps_crud LIMIT 1')).toBeNull()
})
