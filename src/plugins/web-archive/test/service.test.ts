// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  createWaybackService,
  parseWaybackTimestamp,
  waybackTimestamp,
} from '../service.ts'

const CREDS = {accessKey: 'ACCESS-KEY-VALUE', secretKey: 'SECRET-KEY-VALUE'}

const jsonResponse = (body: unknown, init: {ok?: boolean; status?: number} = {}) =>
  ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  }) as unknown as Response

describe('wayback timestamps', () => {
  it('round-trips through the YYYYMMDDhhmmss form', () => {
    const date = new Date('2026-07-30T12:34:56.000Z')
    expect(waybackTimestamp(date)).toBe('20260730123456')
    expect(parseWaybackTimestamp('20260730123456')?.toISOString())
      .toBe('2026-07-30T12:34:56.000Z')
  })

  it('rejects a malformed stamp instead of inventing a date', () => {
    expect(parseWaybackTimestamp('nope')).toBeUndefined()
    expect(parseWaybackTimestamp('2026073012345')).toBeUndefined()
  })
})

describe('submit — authenticated', () => {
  it('posts to Save Page Now and reports acceptance, not archival', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({job_id: 'job-1'}))
    const service = createWaybackService({fetchImpl: fetchImpl as never, credentials: CREDS})

    const result = await service.submit('https://example.com/a')

    expect(result).toEqual({accepted: true})
    // No archiveUrl: the job is queued, the page is not archived yet.
    expect(result.archiveUrl).toBeUndefined()
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://web.archive.org/save')
    expect(init.method).toBe('POST')
    expect(init.body).toBe('url=https%3A%2F%2Fexample.com%2Fa')
  })

  it('throws without echoing the credentials when the service refuses', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, {ok: false, status: 401}))
    const service = createWaybackService({fetchImpl: fetchImpl as never, credentials: CREDS})

    await expect(service.submit('https://example.com/a')).rejects.toThrow(/401/)
    // The message is stored on the record and rendered in the outline; a
    // leaked key there would be synced and permanent.
    await expect(service.submit('https://example.com/a')).rejects.not.toThrow(
      new RegExp(CREDS.accessKey),
    )
  })

  it('throws when the response carries no job id', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({message: 'too many requests'}))
    const service = createWaybackService({fetchImpl: fetchImpl as never, credentials: CREDS})
    await expect(service.submit('https://example.com/a')).rejects.toThrow('too many requests')
  })
})

describe('submit — anonymous', () => {
  it('fires the plain save endpoint and claims only that it was dispatched', async () => {
    const fetchImpl = vi.fn(async () => ({}) as Response)
    const service = createWaybackService({fetchImpl: fetchImpl as never, credentials: undefined})

    const result = await service.submit('https://example.com/a')

    expect(result).toEqual({accepted: true})
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://web.archive.org/save/https://example.com/a')
    // Opaque by necessity — which is exactly why `accepted` is not `archived`.
    expect(init.mode).toBe('no-cors')
  })

  it('propagates a network failure so the record retries', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('offline') })
    const service = createWaybackService({fetchImpl: fetchImpl as never, credentials: undefined})
    await expect(service.submit('https://example.com/a')).rejects.toThrow('offline')
  })
})

describe('resolve', () => {
  const submittedAt = new Date('2026-07-30T12:00:00.000Z')
  const service = (body: unknown, ok = true) =>
    createWaybackService({
      fetchImpl: (async () => jsonResponse(body, {ok, status: ok ? 200 : 503})) as never,
      credentials: undefined,
    })

  it('returns a snapshot taken after the submission, forced to https', async () => {
    const url = await service({
      archived_snapshots: {
        closest: {
          available: true,
          url: 'http://web.archive.org/web/20260730120500/https://example.com/a',
          timestamp: '20260730120500',
        },
      },
    }).resolve('https://example.com/a', submittedAt)

    expect(url).toBe('https://web.archive.org/web/20260730120500/https://example.com/a')
  })

  // The availability API answers with the CLOSEST snapshot, which can predate
  // our submission by years. Reporting that as our result would attach a
  // plausible URL to a claim we never verified.
  it('ignores a snapshot older than the submission', async () => {
    const url = await service({
      archived_snapshots: {
        closest: {
          available: true,
          url: 'https://web.archive.org/web/20190101000000/https://example.com/a',
          timestamp: '20190101000000',
        },
      },
    }).resolve('https://example.com/a', submittedAt)

    expect(url).toBeUndefined()
  })

  it('tolerates a minute of clock skew on the archive side', async () => {
    const url = await service({
      archived_snapshots: {
        closest: {
          available: true,
          url: 'https://web.archive.org/web/20260730115930/https://example.com/a',
          timestamp: '20260730115930',
        },
      },
    }).resolve('https://example.com/a', submittedAt)

    expect(url).toBe('https://web.archive.org/web/20260730115930/https://example.com/a')
  })

  it('returns undefined — not an error — while nothing is archived yet', async () => {
    await expect(service({archived_snapshots: {}}).resolve('https://example.com/a', submittedAt))
      .resolves.toBeUndefined()
    await expect(
      service({archived_snapshots: {closest: {available: false}}})
        .resolve('https://example.com/a', submittedAt),
    ).resolves.toBeUndefined()
  })

  it('throws when the availability check itself fails', async () => {
    await expect(service({}, false).resolve('https://example.com/a', submittedAt))
      .rejects.toThrow(/503/)
  })

  it('asks for snapshots at or after the submission time', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({archived_snapshots: {}}))
    const svc = createWaybackService({fetchImpl: fetchImpl as never, credentials: undefined})
    await svc.resolve('https://example.com/a', submittedAt)
    const [url] = fetchImpl.mock.calls[0] as unknown as [string]
    expect(url).toContain('timestamp=20260730120000')
    expect(url).toContain('url=https%3A%2F%2Fexample.com%2Fa')
  })
})
