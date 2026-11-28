// @vitest-environment happy-dom
import {afterAll, afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb.js'
import {createTestRepo} from '@/data/test/createTestRepo.js'
import type {Repo} from '@/data/repo.js'
import {dailyNotesDataExtension} from '@/plugins/daily-notes/dataExtension.js'
import {dailyNoteBlockId, todayIso} from '@/plugins/daily-notes/dailyNotes.js'
import {appendMatrixMessage, messageNodeId} from './matrix-chat-client.tsx'

vi.mock('https://esm.sh/matrix-js-sdk@38.0.0?bundle', () => ({}))

const config = {workspaceId: 'workspace', baseUrl: 'https://matrix.test', roomId: '!room:matrix.test', autoStart: true, accessToken: 'fixture'}
const event = {event_id: '$event', origin_server_ts: 1700000000000, content: {body: 'new message'}}
const rootId = messageNodeId(config.workspaceId, event.event_id, [0])
const dayId = dailyNoteBlockId(config.workspaceId, todayIso(new Date(event.origin_server_ts)))
const typed = {types: ['matrix-message']}
const currentId = {'matrix-event:id': event.event_id}
const oldId = {'matrix:eventId': event.event_id}
let h: TestDb
let repo: Repo
beforeAll(async () => { h = await createTestDb() })
afterAll(async () => { await h.cleanup() })
beforeEach(async () => {
  await resetTestDb(h.db)
  repo = createTestRepo({db: h.db, extensions: [dailyNotesDataExtension], backfillSyncGate: () => () => {}}).repo
  repo.setActiveWorkspaceId(config.workspaceId)
})
afterEach(() => vi.restoreAllMocks())

const ingest = (body = event.content.body) =>
  appendMatrixMessage(repo, config, {...event, content: {body}}, {}, () => {})

const rawRow = async (
  id: string, properties: Record<string, unknown>,
  {workspaceId = config.workspaceId, deleted = 0, parentId = null}: {workspaceId?: string; deleted?: number; parentId?: string | null} = {},
) => h.db.writeTransaction(tx => tx.execute(
  `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json,
      created_by, updated_by, created_at, updated_at, deleted)
   VALUES (?, ?, ?, 'a0', 'user edit', ?, 'user', 'user', 1, 1, ?)`,
  [id, workspaceId, parentId, JSON.stringify(properties), deleted],
))

const row = (id: string) => h.db.getOptional<{id: string; parent_id: string | null; deleted: number; content: string}>(
  'SELECT id, parent_id, deleted, content FROM blocks WHERE id = ?', [id],
)

it.each([
  ['moved current-key root', {...typed, ...currentId}, 0],
  ['moved old-key root', {...typed, ...oldId}, 0],
  ['deleted current-key root', {...typed, ...currentId}, 1],
  ['deleted old-key root', {...typed, ...oldId}, 1],
] as const)('leaves a %s at its random id and parent', async (_name, props, deleted) => {
  await rawRow('elsewhere', {})
  await rawRow('random', props, {deleted, parentId: 'elsewhere'})
  expect(await ingest()).toBe('random')
  expect(await row(rootId)).toBeNull()
  expect(await row('random')).toMatchObject({parent_id: 'elsewhere', content: 'user edit', deleted})
})

it('recognizes a deterministic tombstone after its type and identity cells are gone', async () => {
  await rawRow(rootId, {}, {deleted: 1})
  await ingest()
  expect(await row(rootId)).toMatchObject({deleted: 1, content: 'user edit'})
  expect(await row(dayId)).toBeNull()
})

it.each([0, 1])('ignores a different type or workspace (deleted=%i)', async deleted => {
  await rawRow('different-type', {types: ['another-type'], ...currentId, ...oldId}, {deleted})
  await rawRow('different-workspace', {...typed, ...currentId, ...oldId}, {deleted, workspaceId: 'other'})
  await ingest()
  expect(await row(rootId)).toMatchObject({content: event.content.body, deleted: 0})
})

it('checks identity before registering a promoted key or opening a write transaction', async () => {
  await rawRow('random', {...typed, ...currentId})
  const register = vi.spyOn(repo.userSchemas, 'addSchema')
  const write = vi.spyOn(repo, 'tx')
  await ingest('- sample\n  - novel:: value')
  expect(register).not.toHaveBeenCalled()
  expect(write).not.toHaveBeenCalled()
})

it('keeps the day and container deleted when a known message replays', async () => {
  await ingest()
  const parent = (await row(rootId))!.parent_id!
  await h.db.writeTransaction(tx => tx.execute(
    'UPDATE blocks SET deleted = 1 WHERE id IN (?, ?, ?)', [dayId, parent, rootId],
  ))
  await ingest()
  expect(await row(parent)).toMatchObject({deleted: 1})
  expect(await row(dayId)).toMatchObject({deleted: 1})
})

it('rechecks an arriving identity under the write lock before creating the day', async () => {
  const write = repo.tx.bind(repo)
  vi.spyOn(repo, 'tx').mockImplementationOnce(async (run, opts) => {
    await rawRow('arrived', {...typed, ...oldId}, {deleted: 1})
    return write(run, opts)
  })
  expect(await ingest()).toBe('arrived')
  expect(await row('arrived')).toMatchObject({deleted: 1})
  expect(await row(dayId)).toBeNull()
  expect(await row(rootId)).toBeNull()
})

it('rechecks before restoring a deleted container when a moved root arrives', async () => {
  await appendMatrixMessage(repo, config, {...event, event_id: '$first'}, {}, () => {})
  const parent = (await row(messageNodeId(config.workspaceId, '$first', [0])))!.parent_id!
  await h.db.writeTransaction(tx => tx.execute('UPDATE blocks SET deleted = 1 WHERE id = ?', [parent]))
  const write = repo.tx.bind(repo)
  vi.spyOn(repo, 'tx').mockImplementationOnce(async (run, opts) => {
    await rawRow('moved', {...typed, ...currentId})
    return write(run, opts)
  })
  await ingest()
  expect(await row('moved')).toMatchObject({content: 'user edit'})
  expect(await row(parent)).toMatchObject({deleted: 1})
  expect(await row(rootId)).toBeNull()
})

it('skips the identity read for an event without an id', async () => {
  const read = vi.spyOn(repo.db, 'getOptional')
  await appendMatrixMessage(repo, config, {...event, event_id: ''}, {}, () => {})
  expect(read).not.toHaveBeenCalled()
})

it('stops before the initial identity read when the workspace has changed', async () => {
  const read = vi.spyOn(repo.db, 'getOptional')
  await expect(appendMatrixMessage(repo, config, event, {}, () => { throw new Error('stopped') }))
    .rejects.toThrow('stopped')
  expect(read).not.toHaveBeenCalled()
})

it('refuses a foreign occupant at the derived root id and leaves it alone', async () => {
  await rawRow(rootId, {}, {workspaceId: 'other'})
  await expect(ingest()).rejects.toThrow('already exists')
  expect(await row(rootId)).toMatchObject({content: 'user edit'})
  expect(await row(dayId)).toBeNull()
})

it('bounds the live property lookup by type and workspace and scans only the tombstone index', async () => {
  await rawRow(rootId, {})
  const read = vi.spyOn(repo.db, 'getOptional')
  await ingest()
  const [sql, params] = read.mock.calls[0]
  const plan = (await h.db.getAll<{detail: string}>(`EXPLAIN QUERY PLAN ${sql}`, params)).map(row => row.detail)
  expect(plan).toContain('SEARCH t USING INDEX idx_block_types_type_workspace (type=? AND workspace_id=?)')
  expect(plan).toContain('SCAN blocks USING INDEX idx_blocks_parent_deleted')
})
