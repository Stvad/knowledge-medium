import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { createSupabaseConversionServer, IDS_PER_FILTER, type ConversionServer } from './conversionServer.js'

type Row = Record<string, unknown>

const valueAt = (row: Row, path: string): unknown => {
  const [column, key] = path.split('->>')
  const value = row[column]
  return key === undefined ? value : (value as Row | null)?.[key]
}

/** Just enough of the PostgREST query builder, over in-memory tables. A
 *  response holds at most `maxRows` rows, like PostgREST's `db-max-rows`, and
 *  without an `order` comes back in no particular order. */
const fakeClient = (
  tables: Record<string, Row[]>,
  {maxRows = Infinity, error, status = 400}: {maxRows?: number; error?: {code: string; message: string}; status?: number} = {},
) => {
  const inListLengths: number[] = []
  const rpcs: Array<{fn: string; args: unknown; signal?: AbortSignal}> = []
  /** Every request made, table read or RPC, with the signal it was handed. */
  const requests: Array<{signal?: AbortSignal}> = []
  const from = (table: string) => {
    const request: {signal?: AbortSignal} = {}
    requests.push(request)
    const filters: Array<(row: Row) => boolean> = []
    let orderBy: string | undefined
    let limit = Infinity
    let maybeSingle = false
    let head = false
    const respond = () => {
      if (error) return {data: null, count: null, error, status}
      let rows = tables[table].filter(row => filters.every(filter => filter(row))).reverse()
      if (head) return {data: null, count: rows.length, error: null, status: 200}
      if (orderBy !== undefined) {
        const key = orderBy
        rows = [...rows].sort((a, b) => ((valueAt(a, key) as string | number) < (valueAt(b, key) as string | number) ? -1 : 1))
      }
      rows = rows.slice(0, Math.min(limit, maxRows))
      return {data: maybeSingle ? (rows[0] ?? null) : rows, count: null, error: null, status: 200}
    }
    const builder = {
      select: (_columns: string, options?: {head?: boolean}) => ((head = options?.head ?? false), builder),
      eq: (column: string, value: unknown) => (filters.push(row => valueAt(row, column) === value), builder),
      gt: (column: string, value: string | number) =>
        (filters.push(row => (valueAt(row, column) as string | number) > value), builder),
      in: (column: string, values: unknown[]) => {
        inListLengths.push(values.length)
        filters.push(row => values.includes(valueAt(row, column)))
        return builder
      },
      contains: (column: string, values: unknown[]) =>
        (filters.push(row => values.every(value => (valueAt(row, column) as unknown[] | null)?.includes(value))), builder),
      like: (column: string, pattern: string) => {
        if (!/^[^%_*]*%$/.test(pattern)) throw new Error(`fake: unsupported pattern ${pattern}`)
        filters.push(row => String(valueAt(row, column)).startsWith(pattern.slice(0, -1)))
        return builder
      },
      order: (column: string) => ((orderBy = column), builder),
      limit: (count: number) => ((limit = count), builder),
      maybeSingle: () => ((maybeSingle = true), builder),
      abortSignal: (signal: AbortSignal) => ((request.signal = signal), builder),
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(respond()).then(resolve, reject),
    }
    return builder
  }
  const rpc = (fn: string, args: unknown) => {
    const call: {fn: string; args: unknown; signal?: AbortSignal} = {fn, args}
    rpcs.push(call)
    requests.push(call)
    const response = {
      abortSignal: (signal: AbortSignal) => ((call.signal = signal), response),
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve({error: error ?? null, status: error ? status : 204}).then(resolve, reject),
    }
    return response
  }
  return {client: {from, rpc} as unknown as SupabaseClient, inListLengths, rpcs, requests}
}

const WS = 'ws-1'
const blockId = (i: number) => `b${String(i).padStart(3, '0')}`
const ENVELOPE = 'enc:v1:AAAA'

/** One call of every server method but the flip, typed over the interface: a
 *  method added to it doesn't compile here until it's listed. */
const cancellableCalls: {[K in Exclude<keyof ConversionServer, 'convertWorkspaceToE2ee'>]: (server: ConversionServer) => Promise<unknown>} = {
  readWorkspace: server => server.readWorkspace(WS),
  countBlocks: server => server.countBlocks(WS),
  readBlockPage: server => server.readBlockPage(WS, null, 1),
  readBlocks: server => server.readBlocks(WS, [blockId(0)]),
  readContentSealHistory: server => server.readContentSealHistory(WS, [blockId(0)]),
  applyBlockPatches: server => server.applyBlockPatches([]),
}

describe('createSupabaseConversionServer', () => {
  it('reads the history of any number of blocks, across id chunks and capped responses', async () => {
    const ids = Array.from({length: 250}, (_, i) => blockId(i))
    let eventId = 0
    const historyRow = (block: string, overrides: Row = {}): Row => ({
      event_id: ++eventId,
      block_id: block,
      workspace_id: WS,
      op: 'U',
      changed_columns: ['content', 'properties_json', 'references_json', 'updated_at'],
      before_diff: {content: 'plain'},
      after_diff: {content: ENVELOPE},
      ...overrides,
    })
    const wanted = ids.flatMap(id => [historyRow(id), historyRow(id)])
    const unwanted = ids.flatMap(id => [
      historyRow(id, {op: 'I'}),
      historyRow(id, {changed_columns: ['content', 'updated_at']}),
      historyRow(id, {after_diff: {content: 'still plain'}}),
      historyRow(id, {workspace_id: 'ws-other'}),
    ])
    const {client, inListLengths} = fakeClient({blocks_history: [...unwanted, ...wanted]}, {maxRows: 7})

    const rows = await createSupabaseConversionServer(client).readContentSealHistory(WS, ids)

    expect(rows.map(row => row.event_id).sort((a, b) => a - b)).toEqual(wanted.map(row => row.event_id))
    expect(Math.max(...inListLengths)).toBeLessThanOrEqual(IDS_PER_FILTER)
  })

  it('reads blocks by id in chunks', async () => {
    const blocks = Array.from({length: 250}, (_, i) => ({id: blockId(i), workspace_id: WS}))
    const {client, inListLengths} = fakeClient({blocks: [...blocks, {id: 'x', workspace_id: 'ws-other'}]})

    const rows = await createSupabaseConversionServer(client).readBlocks(WS, [...blocks.map(b => b.id), 'x'])

    expect([...rows].sort((a, b) => (a.id < b.id ? -1 : 1))).toEqual(blocks)
    expect(Math.max(...inListLengths)).toBeLessThanOrEqual(IDS_PER_FILTER)
  })

  it('pages the workspace\'s blocks by id, after the cursor', async () => {
    const blocks = [3, 0, 4, 1, 2].map(i => ({id: blockId(i), workspace_id: WS}))
    const {client} = fakeClient({blocks: [...blocks, {id: blockId(5), workspace_id: 'ws-other'}]})
    const server = createSupabaseConversionServer(client)

    expect((await server.readBlockPage(WS, null, 2)).map(row => row.id)).toEqual([blockId(0), blockId(1)])
    expect((await server.readBlockPage(WS, blockId(1), 9)).map(row => row.id)).toEqual([blockId(2), blockId(3), blockId(4)])
  })

  it('flips with the workspace id and canary', async () => {
    const {client, rpcs} = fakeClient({})

    await createSupabaseConversionServer(client).convertWorkspaceToE2ee(WS, ENVELOPE)

    expect(rpcs.map(({fn, args}) => ({fn, args}))).toEqual([{fn: 'convert_workspace_to_e2ee', args: {p_workspace_id: WS, p_wk_canary: ENVELOPE}}])
  })

  it('lets the run cancel every request of every method but the flip, which may commit with nobody waiting', async () => {
    for (const [method, call] of Object.entries(cancellableCalls)) {
      const {client, requests} = fakeClient({blocks: [], blocks_history: [], workspaces: []})
      const run = new AbortController()
      await call(createSupabaseConversionServer(client, run.signal))
      expect(requests.length, method).toBeGreaterThan(0)
      expect(requests.map(request => request.signal), method).toEqual(requests.map(() => run.signal))
    }

    const {client, requests} = fakeClient({})
    const run = new AbortController()
    await createSupabaseConversionServer(client, run.signal).convertWorkspaceToE2ee(WS, ENVELOPE)
    run.abort()
    expect(requests).toHaveLength(1)
    expect(requests[0].signal?.aborted).toBe(false)
  })

  it('gives up waiting on a flip request past its own deadline', async () => {
    const {client, rpcs} = fakeClient({workspaces: []})
    await createSupabaseConversionServer(client, undefined, {flipTimeoutMs: 1}).convertWorkspaceToE2ee(WS, ENVELOPE)

    await vi.waitFor(() => expect(rpcs[0].signal?.aborted).toBe(true))
  })

  it('reads a workspace this session cannot see as null', async () => {
    const {client} = fakeClient({workspaces: [{id: 'ws-other', encryption_mode: 'e2ee', wk_canary: ENVELOPE}]})

    expect(await createSupabaseConversionServer(client).readWorkspace(WS)).toBeNull()
  })

  it('counts the workspace\'s rows', async () => {
    const blocks = [0, 1, 2].map(i => ({id: blockId(i), workspace_id: WS}))
    const {client} = fakeClient({blocks: [...blocks, {id: 'x', workspace_id: 'ws-other'}]})

    expect(await createSupabaseConversionServer(client).countBlocks(WS)).toBe(3)
  })

  it('throws a server error with its code and HTTP status', async () => {
    const {client} = fakeClient({workspaces: [], blocks: []}, {error: {code: '42501', message: 'permission denied'}, status: 403})
    const server = createSupabaseConversionServer(client)
    const refused = {code: '42501', status: 403}

    await expect(server.readWorkspace(WS)).rejects.toMatchObject(refused)
    await expect(server.countBlocks(WS)).rejects.toMatchObject(refused)
    await expect(server.readBlockPage(WS, null, 1)).rejects.toMatchObject(refused)
    await expect(server.applyBlockPatches([])).rejects.toMatchObject(refused)
    await expect(server.convertWorkspaceToE2ee(WS, ENVELOPE)).rejects.toMatchObject(refused)
  })
})
