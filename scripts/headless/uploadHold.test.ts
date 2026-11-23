// @vitest-environment node
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import Database from 'better-sqlite3'
import {afterAll, afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest'
import {createTestDb, resetTestDb} from '@/data/test/createTestDb'
import {stubLocalStorage} from '@/data/test/e2eeFixtures'
import {clearSyncState, serverWorkspace, stagedBlock, syncServer, testWorkspaceRow} from '@/data/test/syncCheckpoint'
import {UploadHeldError} from '@/services/powersync'
import {serveDatabase} from './host'
import {STALE_QUEUE_REASON} from './uploadHold'
import {startHost} from './test/startHost'

const {rpc} = vi.hoisted(() => ({
  rpc: vi.fn(() => ({abortSignal: async () => ({error: null, status: 200})})),
}))
vi.mock('@/services/supabase', () => ({hasSupabaseAuthConfig: true, supabase: {rpc}}))

const day = 86_400_000
const workspaceId = 'workspace'
const user = {id: 'member', name: 'Test'}
const config = {mode: 'plaintext' as const, profile: 'fixture', writable: true, workspaceId, stateDir: ''}
const member = {type: 'workspace_members' as const, id: 'member', data: {
  workspace_id: workspaceId, user_id: user.id, role: 'editor', create_time: 1,
}}
const initialRows = [serverWorkspace(testWorkspaceRow(workspaceId)), member]
type Fixture = Awaited<ReturnType<typeof createTestDb>>
type QueueHead = {entry_id: number; first_seen_ms: number}
let fixture: Fixture
beforeAll(async () => { fixture = await createTestDb() })
beforeEach(async () => {
  await clearSyncState(fixture.db)
  await resetTestDb(fixture.db)
  stubLocalStorage()
  vi.stubGlobal('document', {querySelectorAll: () => [], baseURI: 'node:headless'})
})
afterEach(() => { rpc.mockReset(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
afterAll(async () => { await fixture.cleanup() })

const queuePatch = async (stamp?: number, txId: number | null = null) => {
  const id = crypto.randomUUID()
  await fixture.db.execute('INSERT INTO ps_crud (tx_id, data) VALUES (?, ?)', [txId,
    JSON.stringify({op: 'PATCH', type: 'blocks', id, data: {
      workspace_id: workspaceId, content: 'pending edit', updated_at: stamp, base_updated_at: 1,
    }}),
  ])
  return id
}
const queued = (db = fixture.db) => db.getAll<{id: number; data: string}>('SELECT * FROM ps_crud ORDER BY id')
const head = (db = fixture.db) => db.getOptional<QueueHead>('SELECT entry_id, first_seen_ms FROM headless_upload_head')
const requireHead = async () => fixture.db.get<QueueHead>('SELECT entry_id, first_seen_ms FROM headless_upload_head')

function start({release = false, db = fixture.db, connect = async () => {}} = {}) {
  const host = startHost(db, config, user, {connect, release})
  return {...host, health: () => host.execute({type: 'health'})}
}

it('starts tracking a legacy queue at first sight and sends fresh patches with zero, skewed or absent row versions', async () => {
  const {db} = fixture
  await syncServer(db)(initialRows)
  await db.writeTransaction(async tx => {
    await tx.execute('DROP TRIGGER IF EXISTS headless_first_upload')
    await tx.execute('DROP TRIGGER IF EXISTS headless_next_upload')
    await tx.execute('DROP TABLE IF EXISTS headless_upload_head')
  })
  const ids = [await queuePatch(0), await queuePatch(Date.now() - 8 * day),
    await queuePatch(Date.now() + 8 * day), await queuePatch()]
  const before = await queued()
  const bootedAt = Date.now()
  const host = start()
  try {
    await expect(host.health()).resolves.toMatchObject({host: {
      uploadHold: null, queuedEntries: 4, oldestQueuedAgeMs: expect.any(Number),
    }})
    const first = await requireHead()
    expect(await db.getAll('SELECT entry_id FROM headless_upload_head')).toEqual([{entry_id: before[0].id}])
    expect(first.first_seen_ms).toBeGreaterThanOrEqual(bootedAt)
    expect(first.first_seen_ms).toBeLessThanOrEqual(Date.now())
    await host.upload()
    expect(rpc).toHaveBeenCalledWith('apply_block_patches', {patches: expect.arrayContaining(
      ids.map(id => expect.objectContaining({id, content: 'pending edit'})),
    )})
    expect(await queued()).toEqual([])
    expect(await head()).toBeNull()
    await expect(host.health()).resolves.toMatchObject({host: {uploadHold: null, queuedEntries: 0, oldestQueuedAgeMs: null}})
  } finally { await host.stop() }
})

it('records an offline enqueue in its own transaction and holds it from a pre-shutdown SQLite image after eight days', async () => {
  const {db, dir} = fixture
  await syncServer(db)(initialRows)
  const snapshotDir = await mkdtemp(join(tmpdir(), 'headless-upload-restart-'))
  const offline = start()
  try {
    await offline.ready
    expect(db.currentStatus.connected).toBe(false)
    const cancelled = Error('Roll back fixture enqueue')
    await expect(db.writeTransaction(async tx => {
      await tx.execute("INSERT INTO ps_crud (data) VALUES ('{}')")
      const row = await tx.get<{id: number; entry_id: number}>(
        'SELECT ps_crud.id, head.entry_id FROM ps_crud CROSS JOIN headless_upload_head AS head',
      )
      expect(row).toEqual({id: expect.any(Number), entry_id: row.id})
      throw cancelled
    })).rejects.toBe(cancelled)
    expect(await queued()).toEqual([])
    expect(await head()).toBeNull()
    const enqueuedAt = Date.now()
    await queuePatch()
    const first = await requireHead()
    const before = await queued()
    expect(first.entry_id).toBe(before[0].id)
    expect(first.first_seen_ms).toBeGreaterThanOrEqual(enqueuedAt)
    expect(first.first_seen_ms).toBeLessThanOrEqual(Date.now())
    expect(rpc).not.toHaveBeenCalled()

    // Reopen the image committed before shutdown so cleanup cannot supply the age.
    const live = new Database(join(dir, 'test.db'), {readonly: true})
    try { await live.backup(join(snapshotDir, 'test.db')) } finally { live.close() }
    await offline.stop()
    const restored = await createTestDb({from: snapshotDir})
    try {
      expect(await head(restored.db)).toEqual(first)
      vi.spyOn(Date, 'now').mockReturnValue(first.first_seen_ms + 8 * day)
      const resumed = start({db: restored.db})
      try {
        await expect(resumed.health()).resolves.toMatchObject({host: {
          readOnly: true, uploadHold: STALE_QUEUE_REASON, queuedEntries: 1, oldestQueuedAgeMs: 8 * day,
        }})
        expect(await head(restored.db)).toEqual(first)
        await expect(resumed.upload()).rejects.toBeInstanceOf(UploadHeldError)
        expect(rpc).not.toHaveBeenCalled()
        expect(await queued(restored.db)).toEqual(before)
      } finally { await resumed.stop() }
    } finally { await restored.cleanup() }
  } finally {
    await offline.stop()
    await rm(snapshotDir, {recursive: true, force: true})
  }
}, 20_000)

it('holds the whole stale queue across restarts and tail writes, blocks a real checkpoint, and drains on release', async () => {
  const {db} = fixture
  const deliver = syncServer(db)
  await deliver(initialRows)
  const baseline = db.currentStatus.lastSyncedAt!.getTime()
  const offline = start()
  let first: QueueHead
  try {
    await offline.ready
    await queuePatch()
    first = await requireHead()
  } finally { await offline.stop() }
  vi.spyOn(Date, 'now').mockReturnValue(first.first_seen_ms + 8 * day)
  const host = start()
  try {
    await host.ready
    await queuePatch(Date.now())
    await queuePatch()
    expect(await db.getAll('SELECT entry_id, first_seen_ms FROM headless_upload_head')).toEqual([first])
    const tailId = await queuePatch()
    await db.execute("DELETE FROM ps_crud WHERE json_extract(data, '$.id') = ?", [tailId])
    expect(await head()).toEqual(first)
    const before = await queued()
    await expect(host.health()).resolves.toMatchObject({host: {
      readOnly: true, uploadHold: STALE_QUEUE_REASON, queuedEntries: 3, oldestQueuedAgeMs: 8 * day,
    }})
    await expect(host.upload()).rejects.toBeInstanceOf(UploadHeldError)
    expect(rpc).not.toHaveBeenCalled()
    expect(await queued()).toEqual(before)
    const block = stagedBlock(crypto.randomUUID(), workspaceId)
    await deliver([block])
    expect(await db.getOptional('SELECT 1 FROM ps_oplog WHERE row_id = ?', [block.id])).toBeTruthy()
    expect(await db.getOptional('SELECT 1 FROM blocks_synced WHERE id = ?', [block.id])).toBeNull()
    await expect(host.health()).resolves.toMatchObject({host: {lastSyncedAt: baseline, closedReason: expect.any(String)}})
  } finally { await host.stop() }
  const beforeRelease = await queued()
  const released = start({release: true})
  try {
    await expect(released.health()).resolves.toMatchObject({host: {
      uploadHold: null, queuedEntries: 3, oldestQueuedAgeMs: 8 * day,
    }})
    expect(await queued()).toEqual(beforeRelease)
    expect(await head()).toEqual(first)
    await released.upload()
    expect(rpc).toHaveBeenCalled()
    expect(await queued()).toEqual([])
    expect(await head()).toBeNull()
    await expect(released.health()).resolves.toMatchObject({host: {uploadHold: null, oldestQueuedAgeMs: null}})
  } finally { await released.stop() }
}, 20_000)

// A real editor boot, edit, and deferred-work shutdown took 10 s under load.
it('makes an admitted editor read-only when its next upload finds a stale head', async () => {
  const {db} = fixture
  const deliver = syncServer(db)
  const id = crypto.randomUUID()
  vi.spyOn(Object.getPrototypeOf(db.currentStatus), 'connected', 'get').mockReturnValue(true)
  const host = start({connect: () => deliver([...initialRows, stagedBlock(id, workspaceId)])})
  const update = (content: string) => host.execute({type: 'update-block', id, contributorId: null, content})
  try {
    await vi.waitFor(async () => expect(await host.health()).toMatchObject({host: {closedReason: null, readOnly: false}}),
      {timeout: 5000})
    await update('queued edit')
    expect(await db.get('SELECT content FROM blocks WHERE id = ?', [id])).toEqual({content: 'queued edit'})
    const first = await requireHead()
    vi.spyOn(Date, 'now').mockReturnValue(first.first_seen_ms + 8 * day)
    await expect(host.upload()).rejects.toBeInstanceOf(UploadHeldError)
    expect(rpc).not.toHaveBeenCalled()
    await expect(host.health()).resolves.toMatchObject({host: {
      closedReason: null, readOnly: true, uploadHold: STALE_QUEUE_REASON,
    }})
    await expect(update('held edit')).rejects.toThrow('read-only mode')
    expect(await db.get('SELECT content FROM blocks WHERE id = ?', [id])).toEqual({content: 'queued edit'})
  } finally { await host.stop() }
}, 40_000)

it('preserves a queued write before the first workspace row can validate its encryption mode', async () => {
  await queuePatch()
  const before = await queued()
  const connect = vi.fn(async () => { throw new Error('Unexpected connection') })
  await expect(serveDatabase(fixture.db, config, user, new AbortController().signal, {connect}))
    .rejects.toThrow('Queued writes without a workspace row')
  expect(connect).not.toHaveBeenCalled()
  expect(await queued()).toEqual(before)
})

it('advances an acknowledged head with a backlog and does not carry the release to the next batch', async () => {
  const {db} = fixture
  await syncServer(db)(initialRows)
  const offline = start()
  const realNow = Date.now
  let first: QueueHead
  try {
    await offline.ready
    // Force two uploader batches with distinct PowerSync transactions.
    for (let txId = 1; txId <= 26; txId++) await queuePatch(undefined, txId)
    first = await requireHead()
    await db.execute('UPDATE headless_upload_head SET first_seen_ms = ?', [first.first_seen_ms - 8 * day])
  } finally { await offline.stop() }
  const before = await queued()
  const host = start({release: true})
  try {
    await expect(host.health()).resolves.toMatchObject({host: {uploadHold: null, queuedEntries: 26}})
    let acknowledgeAt: number | undefined
    rpc.mockImplementationOnce(() => ({abortSignal: async () => {
      acknowledgeAt = realNow()
      // SQLite records the new head at acknowledgement. Age it for the next check.
      vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 8 * day)
      return {error: null, status: 200}
    }}))
    await expect(host.upload()).rejects.toBeInstanceOf(UploadHeldError)
    expect(rpc).toHaveBeenCalledTimes(1)
    const remaining = before.slice(-1)
    expect(await queued()).toEqual(remaining)
    const next = await requireHead()
    expect(next.entry_id).toBe(remaining[0].id)
    expect(next.first_seen_ms).toBeGreaterThanOrEqual(acknowledgeAt!)
    expect(next.first_seen_ms).toBeLessThanOrEqual(realNow())
    await expect(host.health()).resolves.toMatchObject({host: {
      readOnly: true, uploadHold: STALE_QUEUE_REASON, queuedEntries: 1,
    }})
  } finally { await host.stop() }
}, 20_000)

it('allows exactly one week and ignores a release requested before the head becomes stale', async () => {
  await syncServer(fixture.db)(initialRows)
  const offline = start()
  let first: QueueHead
  try {
    await offline.ready
    await queuePatch()
    first = await requireHead()
  } finally { await offline.stop() }
  const clock = vi.spyOn(Date, 'now').mockReturnValue(first.first_seen_ms + 7 * day)
  const host = start({release: true})
  try {
    await expect(host.health()).resolves.toMatchObject({host: {uploadHold: null, oldestQueuedAgeMs: 7 * day}})
    clock.mockReturnValue(first.first_seen_ms + 7 * day + 1)
    await expect(host.upload()).rejects.toBeInstanceOf(UploadHeldError)
    expect(rpc).not.toHaveBeenCalled()
    expect(await queued()).toHaveLength(1)
  } finally { await host.stop() }
}, 20_000)

it('accepts release on an empty device without authorizing a future stale head', async () => {
  await syncServer(fixture.db)(initialRows)
  const host = start({release: true})
  try {
    expect(await host.health()).toMatchObject({host: {uploadHold: null, oldestQueuedAgeMs: null}})
    await queuePatch()
    const first = await requireHead()
    vi.spyOn(Date, 'now').mockReturnValue(first.first_seen_ms + 8 * day)
    await expect(host.upload()).rejects.toBeInstanceOf(UploadHeldError)
    expect(rpc).not.toHaveBeenCalled()
  } finally { await host.stop() }
})
