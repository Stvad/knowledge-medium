import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { BINARY_ENVELOPE_MAGIC } from '../../sync/crypto/binaryEnvelope.js'
import { createSupabaseAuditIO } from './supabaseAuditIO.js'

const URL = 'https://proj.supabase.co'
const KEY = 'svc-key'

/** A chainable supabase query-builder mock. `range()` is the awaited terminal and
 *  returns successive pages keyed by call order. Records `order`/`range` args. */
const makeClient = (opts: {
  workspacePages: Array<Array<{ id: string }>>
  objectPages: Array<Array<{ id: string | null; name: string }>>
}) => {
  const orderSpy = vi.fn()
  const rangeSpy = vi.fn()
  const listSpy = vi.fn()
  let wsCall = 0
  let objCall = 0

  const client = {
    from: vi.fn(() => {
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn(() => builder),
        order: vi.fn((...args: unknown[]) => {
          orderSpy(...args)
          return builder
        }),
        range: vi.fn((from: number, to: number) => {
          rangeSpy(from, to)
          return Promise.resolve({ data: opts.workspacePages[wsCall++] ?? [], error: null })
        }),
      }
      return builder
    }),
    storage: {
      from: vi.fn(() => ({
        list: vi.fn(async (path: string, listOpts: unknown) => {
          listSpy(path, listOpts)
          return { data: opts.objectPages[objCall++] ?? [], error: null }
        }),
      })),
    },
  }
  return { client: client as unknown as SupabaseClient, orderSpy, rangeSpy, listSpy }
}

const bytesResponse = (bytes: Uint8Array, status = 206) => new Response(new Uint8Array(bytes), { status })

describe('createSupabaseAuditIO.listE2eeWorkspaceIds', () => {
  it('selects e2ee workspaces with a STABLE order and paginates by range', async () => {
    const { client, orderSpy, rangeSpy } = makeClient({
      workspacePages: [[{ id: 'ws1' }, { id: 'ws2' }], []],
      objectPages: [],
    })
    const io = createSupabaseAuditIO({ url: URL, serviceKey: KEY, client })
    expect(await io.listE2eeWorkspaceIds()).toEqual(['ws1', 'ws2'])
    // The regression guard: offset pagination MUST carry a deterministic order.
    expect(orderSpy).toHaveBeenCalledWith('id', { ascending: true })
    expect(rangeSpy).toHaveBeenNthCalledWith(1, 0, 999)
    expect(rangeSpy).toHaveBeenNthCalledWith(2, 2, 1001) // advanced by the 2 actual rows
  })
})

describe('createSupabaseAuditIO.listObjects', () => {
  it('lists with an explicit stable sort and maps null-id entries to folders', async () => {
    const { client, listSpy } = makeClient({
      workspacePages: [],
      objectPages: [
        [
          { id: 'x', name: 'deadbeef' },
          { id: null, name: 'sub' },
        ],
        [],
      ],
    })
    const io = createSupabaseAuditIO({ url: URL, serviceKey: KEY, client })
    expect(await io.listObjects('ws1')).toEqual([
      { name: 'deadbeef', isFolder: false },
      { name: 'sub', isFolder: true },
    ])
    expect(listSpy).toHaveBeenCalledWith(
      'ws1',
      expect.objectContaining({ limit: 1000, offset: 0, sortBy: { column: 'name', order: 'asc' } }),
    )
  })
})

describe('createSupabaseAuditIO.readObjectVerdict', () => {
  const ioWith = (fetchFn: typeof fetch) =>
    createSupabaseAuditIO({ url: URL, serviceKey: KEY, client: {} as SupabaseClient, fetchFn })

  it("returns 'ok' for an encb:v1: magic head, with a Range request and encoded path", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => bytesResponse(BINARY_ENVELOPE_MAGIC))
    expect(await ioWith(fetchFn).readObjectVerdict('ws1/deadbeef')).toBe('ok')
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe(`${URL}/storage/v1/object/authenticated/attachments/ws1/deadbeef`)
    expect((init?.headers as Record<string, string>).range).toBe(`bytes=0-${BINARY_ENVELOPE_MAGIC.length - 1}`)
  })

  it("returns 'plaintext' for a non-magic head", async () => {
    const io = ioWith(vi.fn<typeof fetch>(async () => bytesResponse(new Uint8Array([1, 2, 3]))))
    expect(await io.readObjectVerdict('ws1/k')).toBe('plaintext')
  })

  it("returns 'plaintext' for a 0-byte body (can't be an encb:v1: envelope)", async () => {
    const io = ioWith(vi.fn<typeof fetch>(async () => bytesResponse(new Uint8Array([]))))
    expect(await io.readObjectVerdict('ws1/empty')).toBe('plaintext')
  })

  it('percent-encodes each path segment in the Range-GET URL', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => bytesResponse(BINARY_ENVELOPE_MAGIC))
    await ioWith(fetchFn).readObjectVerdict('ws 1/a b#c')
    expect(fetchFn.mock.calls[0][0]).toBe(
      `${URL}/storage/v1/object/authenticated/attachments/ws%201/a%20b%23c`,
    )
  })

  it("returns 'gone' on 404 (deleted mid-scan)", async () => {
    const io = ioWith(vi.fn<typeof fetch>(async () => new Response(null, { status: 404 })))
    expect(await io.readObjectVerdict('ws1/k')).toBe('gone')
  })

  it("returns 'unreadable' on a 416/5xx and never throws", async () => {
    const io416 = ioWith(vi.fn<typeof fetch>(async () => new Response(null, { status: 416 })))
    expect(await io416.readObjectVerdict('ws1/k')).toBe('unreadable')
    const io500 = ioWith(vi.fn<typeof fetch>(async () => new Response('e', { status: 500 })))
    expect(await io500.readObjectVerdict('ws1/k')).toBe('unreadable')
  })

  it("returns 'unreadable' when the fetch (or body read) throws — never aborts", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      throw new Error('connection reset')
    })
    expect(await ioWith(fetchFn).readObjectVerdict('ws1/k')).toBe('unreadable')
  })
})
