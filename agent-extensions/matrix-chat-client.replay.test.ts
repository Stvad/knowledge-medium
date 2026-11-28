// @vitest-environment happy-dom
import {afterAll, afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb.js'
import {createTestRepo} from '@/data/test/createTestRepo.js'
import {dailyNotesDataExtension} from '@/plugins/daily-notes/dataExtension.js'
import {diagnosticsFacet, type DiagnosticSourceContribution} from '@/plugins/diagnostics/facet.js'
import matrixContributions, {createMatrixClient, nextBatchKey, pollLoop} from './matrix-chat-client.tsx'

const config = {
  workspaceId: 'workspace', baseUrl: 'https://matrix.test', roomId: '!room:matrix.test',
  accessToken: 'fixture', autoStart: true,
}
const syncPath = '/_matrix/client/v3/sync'
const historyPath = '/_matrix/client/v3/rooms/!room%3Amatrix.test/messages'
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
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear() })

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
  vi.stubGlobal('fetch', async (url: URL, options: RequestInit) => {
    expect(url.origin).toBe(config.baseUrl)
    expect(options).toMatchObject({
      signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer',
      headers: {Accept: 'application/json', Authorization: 'Bearer fixture'},
    })
    requests.push({
      method: options.method ?? 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams),
      cursor: cursor(),
    })
    if (!replies.length) {
      controller.abort()
      return Response.json({})
    }
    const reply = replies.shift()
    if (reply instanceof Response) return reply
    return Response.json(reply)
  })
  try {
    await pollLoop(repo, config, controller.signal, createMatrixClient(config))
    expect(replies).toHaveLength(0)
    return requests
  } finally {
    unsubscribe()
    controller.abort()
  }
}

it('pages across empty responses, keeps S0 through fetches and writes, and appends oldest-first', async () => {
  const write = repo.tx.bind(repo)
  const duringMessageWrite: string[] = []
  vi.spyOn(repo, 'tx').mockImplementation(async (fn, opts) => {
    const before = cursor()
    const count = (await contents()).length
    const result = await write(fn, opts)
    if ((await contents()).length > count) duringMessageWrite.push(before, cursor())
    return result
  })
  const requests = await run(
    sync('S1', ['five'], limited),
    {chunk: [event('four'), event('three')], end: 'P2'},
    {chunk: [], end: 'P3'},
    {chunk: [event('two'), event('one')]},
  )
  expect(requests.map(r => r.path)).toEqual([syncPath, historyPath, historyPath, historyPath, syncPath])
  expect(requests.slice(1, 4)).toEqual(['P1', 'P2', 'P3'].map(from => ({
    method: 'GET', path: historyPath, cursor: 'S0', query: expect.objectContaining({from, to: 'S0', dir: 'b'}),
  })))
  expect(new Set(duringMessageWrite)).toEqual(new Set(['S0']))
  expect(requests[0].query).toMatchObject({since: 'S0', timeout: '30000'})
  expect(JSON.parse(requests[0].query.filter).room).toMatchObject({
    rooms: [config.roomId], timeline: {types: ['m.room.message'], limit: 30},
  })
  expect(requests[1].query).toMatchObject({filter: JSON.stringify({types: ['m.room.message']}), limit: '100'})
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
  await run(batch, new Response('<h1>Upstream unavailable</h1>', {status: 503}))
  expect(diagnostics.getSnapshot()).toMatchObject({
    summary: 'Matrix ingest is retrying', detail: 'Matrix HTTP 503',
  })
  expect(cursor()).toBe('S0')
  expect(await contents()).toEqual([])
  const requests = await run(batch, {chunk: [event('older')]})
  expect(requests.filter(r => r.path === syncPath).map(r => r.query.since)).toEqual(['S0', 'S1'])
  expect(await contents()).toEqual(['older', 'newer'])
})

it('backfills a limited interval from the shared position in a room with no imported messages', async () => {
  await run(sync('S0', []))
  localStorage.removeItem(nextBatchKey(config))
  const requests = await run(sync('S1', ['newer'], limited), {chunk: [event('older')], end: 'S0'})
  expect(requests.map(r => r.path)).toEqual([syncPath, historyPath, syncPath])
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

it.each([
  [401, 'M_UNKNOWN_TOKEN', 'Token expired', 'Matrix ingest error'],
  [429, 'M_LIMIT_EXCEEDED', 'Slow down', 'Matrix ingest is retrying'],
] as const)('classifies Matrix HTTP %i without advancing the cursor', async (status, errcode, error, summary) => {
  await run(Response.json({errcode, error}, {status}))
  expect(diagnostics.getSnapshot()).toMatchObject({
    summary, detail: `Matrix HTTP ${status}: ${errcode}: ${error}`,
  })
  expect(cursor()).toBe('S0')
  expect(await contents()).toEqual([])
})

it('preserves opaque sync and pagination tokens on the wire', async () => {
  const since = 's+/?&=☃'
  const from = 'p+/?&=☃'
  localStorage.setItem(nextBatchKey(config), JSON.stringify({nextBatch: since}))
  const requests = await run(sync('S1', [], {limited: true, prev_batch: from}), {chunk: [], end: since})
  expect(requests[0].query.since).toBe(since)
  expect(requests[1].query).toMatchObject({from, to: since})
  expect(cursor()).toBe('S1')
})

it('reports the HTTP status when a server returns malformed Matrix error fields', async () => {
  await run(Response.json({errcode: {}, error: ''}, {status: 401}))
  expect(diagnostics.getSnapshot()).toMatchObject({summary: 'Matrix ingest error', detail: 'Matrix HTTP 401'})
})
