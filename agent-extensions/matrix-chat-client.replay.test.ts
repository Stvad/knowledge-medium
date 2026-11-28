// @vitest-environment happy-dom
import {afterAll, afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb.js'
import {createTestRepo} from '@/data/test/createTestRepo.js'
import {dailyNotesDataExtension} from '@/plugins/daily-notes/dataExtension.js'
import {diagnosticsFacet, type DiagnosticSourceContribution} from '@/plugins/diagnostics/facet.js'
import matrixContributions, {nextBatchKey, pollLoop} from './matrix-chat-client.tsx'

vi.mock('https://esm.sh/matrix-js-sdk@38.0.0?bundle', () => ({}))

const config = {
  workspaceId: 'workspace', baseUrl: 'https://matrix.test', roomId: '!room:matrix.test',
  accessToken: 'fixture', autoStart: true,
}
const historyPath = '/rooms/!room%3Amatrix.test/messages'
const diagnostics = matrixContributions.find(c => c.facet.id === diagnosticsFacet.id)!.value as DiagnosticSourceContribution
const cursor = () => JSON.parse(localStorage.getItem(nextBatchKey(config)) ?? 'null')?.nextBatch
const event = (body: string) => ({
  type: 'm.room.message', event_id: '$' + body, origin_server_ts: 1_700_000_000_000, content: {body},
})
const sync = (next: string, bodies: string[], timeline = {}) => ({
  next_batch: next,
  rooms: {join: {[config.roomId]: {timeline: {events: bodies.map(event), ...timeline}}}},
})
const limited = {limited: true, prev_batch: 'P1'}
let h: TestDb
let repo: ReturnType<typeof createTestRepo>['repo']
beforeAll(async () => { h = await createTestDb() })
afterAll(async () => { await h.cleanup() })
beforeEach(async () => {
  await resetTestDb(h.db)
  repo = createTestRepo({db: h.db, extensions: [dailyNotesDataExtension]}).repo
  repo.setActiveWorkspaceId(config.workspaceId)
  localStorage.setItem(nextBatchKey(config), JSON.stringify({nextBatch: 'S0'}))
})
afterEach(() => { vi.restoreAllMocks(); localStorage.clear() })

const contents = async () => (await h.db.getAll<{content: string}>(
  `SELECT content FROM blocks WHERE json_extract(properties_json, '$."matrix-event:id"') IS NOT NULL
     AND deleted = 0 ORDER BY order_key, id`,
)).map(row => row.content)

// A final long poll ends the script. Abort after a poll error reaches the
// diagnostic so tests can inspect a failed interval before restarting.
const run = async (...replies: unknown[]) => {
  const controller = new AbortController()
  const requests: Array<{method: string; path: string; query: Record<string, string>; cursor: string | undefined}> = []
  const unsubscribe = diagnostics.subscribe(() => {
    if (diagnostics.getSnapshot()?.severity === 'warning') queueMicrotask(() => controller.abort())
  })
  const http = {authedRequest: async (method: string, path: string, query: Record<string, string>) => {
    requests.push({method, path, query, cursor: cursor()})
    if (!replies.length) {
      controller.abort()
      return {}
    }
    const reply = replies.shift()
    if (reply instanceof Error) throw reply
    return reply
  }}
  try {
    await pollLoop(repo, config, controller.signal, {http})
    expect(replies).toHaveLength(0)
    return requests
  } finally {
    unsubscribe()
    controller.abort()
  }
}

it('pages across empty responses, keeps S0 through fetches and writes, and appends oldest-first', async () => {
  const write = repo.tx.bind(repo)
  const duringWrite: string[] = []
  vi.spyOn(repo, 'tx').mockImplementation(async (fn, opts) => {
    duringWrite.push(cursor())
    const result = await write(fn, opts)
    duringWrite.push(cursor())
    return result
  })
  const requests = await run(
    sync('S1', ['five'], limited),
    {chunk: [event('four'), event('three')], end: 'P2'},
    {chunk: [], end: 'P3'},
    {chunk: [event('two'), event('one')]},
  )
  expect(requests.map(r => r.path)).toEqual(['/sync', historyPath, historyPath, historyPath, '/sync'])
  expect(requests.slice(1, 4)).toEqual(['P1', 'P2', 'P3'].map(from => ({
    method: 'GET', path: historyPath, cursor: 'S0', query: expect.objectContaining({from, to: 'S0', dir: 'b'}),
  })))
  expect(new Set(duringWrite)).toEqual(new Set(['S0']))
  expect(requests.at(-1)?.query.since).toBe('S1')
  expect(cursor()).toBe('S1')
  expect(await contents()).toEqual(['one', 'two', 'three', 'four', 'five'])
  expect(diagnostics.getSnapshot()?.summary).toBe('Matrix history gap recovered')
})

it('recovers an older missing event beyond a newer known event', async () => {
  await run(sync('S1', ['known']))
  await run(sync('S2', [], limited), {chunk: [event('known'), event('missing')], end: 'S1'})
  expect(cursor()).toBe('S2')
  expect(await contents()).toEqual(['known', 'missing'])
})

it('retries a failed history fetch from the last saved sync position', async () => {
  const batch = sync('S1', ['newer'], limited)
  await run(batch, Object.assign(new Error('temporary failure'), {httpStatus: 500}))
  expect(cursor()).toBe('S0')
  expect(await contents()).toEqual([])
  const requests = await run(batch, {chunk: [event('older')]})
  expect(requests.filter(r => r.path === '/sync').map(r => r.query.since)).toEqual(['S0', 'S1'])
  expect(await contents()).toEqual(['older', 'newer'])
})

it('skips fresh-sync history, then backfills a limited interval in an empty graph', async () => {
  localStorage.removeItem(nextBatchKey(config))
  const baseline = await run(sync('S0', ['ignored'], limited))
  expect(baseline.map(r => r.path)).toEqual(['/sync', '/sync'])
  expect(await contents()).toEqual([])
  const requests = await run(sync('S1', ['newer'], limited), {chunk: [event('older')], end: 'S0'})
  expect(requests.map(r => r.path)).toEqual(['/sync', historyPath, '/sync'])
  expect(requests[1].query.to).toBe('S0')
  expect(await contents()).toEqual(['older', 'newer'])
})

it.each([
  {name: 'invalid prev_batch', timeline: {...limited, prev_batch: ''}, pages: [], detail: 'Matrix history has an invalid starting token'},
  {name: 'missing timeline events', timeline: {...limited, events: null}, pages: [], detail: 'Matrix timeline has no events array'},
  {name: 'malformed chunk', timeline: limited, pages: [{end: 'S0'}], detail: 'Matrix history page has no chunk'},
  {name: 'invalid end', timeline: limited, pages: [{chunk: [], end: 1}], detail: 'Matrix history page has an invalid end token'},
  {name: 'repeating token', timeline: limited, pages: [{chunk: [], end: 'P1'}], detail: 'Matrix history pagination repeated a token'},
])('refuses $name before advancing the cursor or writing', async ({timeline, pages, detail}) => {
  await run(sync('S1', ['newer'], timeline), ...pages)
  expect(diagnostics.getSnapshot()?.detail).toBe(detail)
  expect(cursor()).toBe('S0')
  expect(await contents()).toEqual([])
})

it('uses the sync upper bound when the server omits prev_batch', async () => {
  const requests = await run(sync('S1', ['latest'], {limited: true}), {chunk: [event('latest')], end: 'S0'})
  expect(requests[1]).toMatchObject({path: historyPath, query: {from: 'S1', to: 'S0', dir: 'b'}})
  expect(cursor()).toBe('S1')
  expect(await contents()).toEqual(['latest'])
})
