import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startBridgeLoop, type BridgeLoop, type BridgeLoopOptions } from '../bridgeLoop.ts'

let loop: BridgeLoop | null = null

const makeWarnSpy = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined)
let warn!: ReturnType<typeof makeWarnSpy>

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return {promise, resolve, reject}
}

const makeOptions = (overrides: Partial<BridgeLoopOptions> = {}): BridgeLoopOptions => ({
  clientId: 'client-1',
  baseUrl: () => 'http://bridge.test',
  headers: () => ({authorization: 'HEADER_SECRET_MARKER'}),
  registration: () => ({token: 'BODY_SECRET_MARKER'}),
  execute: async () => undefined,
  fetch: vi.fn(async () => new Response(null, {status: 200})) as unknown as typeof fetch,
  ...overrides,
})

beforeEach(() => {
  warn = makeWarnSpy()
})

afterEach(() => {
  loop?.stop()
  loop = null
  vi.restoreAllMocks()
})

describe('bridge loop diagnostics', () => {
  it('classifies a missing browser pairing when headers fail before fetch', async () => {
    const fetch = vi.fn(async () => new Response(null, {status: 200}))
    loop = startBridgeLoop(makeOptions({
      headers: () => { throw new Error('Agent runtime bridge is not paired. PAIRING_SECRET_MARKER') },
      fetch: fetch as unknown as typeof globalThis.fetch,
    }))

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))

    expect(fetch).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('Agent runtime diagnostic', JSON.stringify({
      stage: 'headers',
      name: 'Error',
      category: 'missing-browser-bridge-pairing',
    }))
    expect(JSON.stringify(warn.mock.calls)).not.toContain('PAIRING_SECRET_MARKER')
  })

  it('classifies fetch TypeErrors and omits header, body, and error details', async () => {
    const fetch = vi.fn(async () => { throw new TypeError('fetch failed: ERROR_SECRET_MARKER') })
    loop = startBridgeLoop(makeOptions({fetch: fetch as unknown as typeof globalThis.fetch}))

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))

    expect(warn).toHaveBeenCalledWith('Agent runtime diagnostic', JSON.stringify({
      stage: 'registration-fetch',
      name: 'TypeError',
      category: 'type-or-fetch-error',
    }))
    const logged = JSON.stringify(warn.mock.calls)
    for (const marker of ['HEADER_SECRET_MARKER', 'BODY_SECRET_MARKER', 'ERROR_SECRET_MARKER']) {
      expect(logged).not.toContain(marker)
    }
  })

  it('reads an error name only once before logging a safe classification', async () => {
    let nameReads = 0
    const error = new Error('safe fetch failure')
    Object.defineProperty(error, 'name', {
      get: () => {
        nameReads += 1
        return nameReads < 3 ? 'TypeError' : 'STATEFUL_SECRET_NAME_MARKER'
      },
    })
    const fetch = vi.fn(async () => { throw error })
    loop = startBridgeLoop(makeOptions({fetch: fetch as unknown as typeof globalThis.fetch}))

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))

    expect(nameReads).toBe(1)
    expect(warn).toHaveBeenCalledWith('Agent runtime diagnostic', JSON.stringify({
      stage: 'registration-fetch',
      name: 'TypeError',
      category: 'type-or-fetch-error',
    }))
    expect(JSON.stringify(warn.mock.calls)).not.toContain('STATEFUL_SECRET_NAME_MARKER')
  })

  it('safely handles throwing error accessors and retries after wake', async () => {
    const error = Object.defineProperties(new Error('hidden error'), {
      name: {get: () => { throw new Error('NAME_GETTER_SECRET_MARKER') }},
      message: {get: () => { throw new Error('MESSAGE_GETTER_SECRET_MARKER') }},
    })
    const fetch = vi.fn(async () => { throw error })
    loop = startBridgeLoop(makeOptions({fetch: fetch as unknown as typeof globalThis.fetch}))

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
    expect(warn).toHaveBeenCalledWith('Agent runtime diagnostic', JSON.stringify({
      stage: 'registration-fetch',
      name: 'Error',
      category: 'other',
    }))
    expect(JSON.stringify(warn.mock.calls)).not.toContain('NAME_GETTER_SECRET_MARKER')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('MESSAGE_GETTER_SECRET_MARKER')

    loop.wake()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('classifies an HTTP registration error without logging its response details', async () => {
    const fetch = vi.fn(async () => ({ok: false, status: 401} as Response))
    loop = startBridgeLoop(makeOptions({fetch: fetch as unknown as typeof globalThis.fetch}))

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))

    expect(warn).toHaveBeenCalledWith('Agent runtime diagnostic', JSON.stringify({
      stage: 'registration-fetch',
      name: 'Error',
      category: 'http-error',
      httpStatus: 401,
    }))
  })

  it('does not warn when stopping aborts the in-progress request', async () => {
    let signal: AbortSignal | undefined
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {once: true})
      })
    })
    loop = startBridgeLoop(makeOptions({fetch: fetch as unknown as typeof globalThis.fetch}))

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    loop.stop()
    await vi.waitFor(() => expect(signal?.aborted).toBe(true))
    await Promise.resolve()
    await Promise.resolve()

    expect(warn).not.toHaveBeenCalled()
  })

  it('keeps the poll failure stage when a separate registration runs during a pending poll', async () => {
    const pendingPoll = deferred<Response>()
    const fetch = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input instanceof Request ? input.url : input))
      if (url.pathname === '/runtime/commands/next') return pendingPoll.promise
      return Promise.resolve(new Response(null, {status: 200}))
    })
    loop = startBridgeLoop(makeOptions({fetch: fetch as unknown as typeof globalThis.fetch}))

    await vi.waitFor(() => {
      const pollStarted = fetch.mock.calls.some(([input]) =>
        new URL(String(input instanceof Request ? input.url : input)).pathname === '/runtime/commands/next',
      )
      expect(pollStarted).toBe(true)
    })

    await loop.register()
    pendingPoll.reject(new TypeError('poll fetch failed: POLL_ERROR_SECRET_MARKER'))
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))

    expect(warn).toHaveBeenCalledWith('Agent runtime diagnostic', JSON.stringify({
      stage: 'poll-fetch',
      name: 'TypeError',
      category: 'type-or-fetch-error',
    }))
    expect(JSON.stringify(warn.mock.calls)).not.toContain('POLL_ERROR_SECRET_MARKER')
  })

  it('deduplicates repeated failures until a successful poll, then logs the same failure again', async () => {
    const successfulPoll = deferred<Response>()
    let pollRequests = 0
    const fetch = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input instanceof Request ? input.url : input))
      if (url.pathname !== '/runtime/commands/next') {
        return Promise.resolve(new Response(null, {status: 200}))
      }

      pollRequests += 1
      if (pollRequests === 3) return successfulPoll.promise
      return Promise.reject(new TypeError('fetch failed'))
    })
    loop = startBridgeLoop(makeOptions({fetch: fetch as unknown as typeof globalThis.fetch}))

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
    expect(warn).toHaveBeenLastCalledWith('Agent runtime diagnostic', JSON.stringify({
      stage: 'poll-fetch',
      name: 'TypeError',
      category: 'type-or-fetch-error',
    }))

    loop.wake()
    await vi.waitFor(() => expect(pollRequests).toBe(2))
    expect(warn).toHaveBeenCalledTimes(1)

    loop.wake()
    await vi.waitFor(() => expect(pollRequests).toBe(3))
    expect(warn).toHaveBeenCalledTimes(1)
    successfulPoll.resolve(new Response('null', {status: 200, headers: {'content-type': 'application/json'}}))

    await vi.waitFor(() => expect(pollRequests).toBe(4))
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2))
    expect(warn).toHaveBeenLastCalledWith('Agent runtime diagnostic', JSON.stringify({
      stage: 'poll-fetch',
      name: 'TypeError',
      category: 'type-or-fetch-error',
    }))
  })

  it('logs a changed diagnostic phase and category without waiting for a successful poll', async () => {
    let pairingMissing = true
    const headers = vi.fn(() => {
      if (pairingMissing) throw new Error('Agent runtime bridge is not paired.')
      return {authorization: 'HEADER_SECRET_MARKER'}
    })
    const fetch = vi.fn(async () => { throw new TypeError('fetch failed') })
    loop = startBridgeLoop(makeOptions({
      headers,
      fetch: fetch as unknown as typeof globalThis.fetch,
    }))

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
    expect(warn).toHaveBeenLastCalledWith('Agent runtime diagnostic', JSON.stringify({
      stage: 'headers',
      name: 'Error',
      category: 'missing-browser-bridge-pairing',
    }))

    pairingMissing = false
    loop.wake()
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2))
    expect(warn).toHaveBeenLastCalledWith('Agent runtime diagnostic', JSON.stringify({
      stage: 'registration-fetch',
      name: 'TypeError',
      category: 'type-or-fetch-error',
    }))
  })
})
