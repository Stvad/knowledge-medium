import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgeNotPairedError, startBridgeLoop, type BridgeLoop, type BridgeLoopOptions } from '../bridgeLoop.ts'

const baseUrl = 'http://bridge.test'
const unavailable = (reason: string) =>
  `Agent runtime bridge unavailable at ${baseUrl} (${reason}); retrying quietly every 60 seconds.`
const jsonResponse = (body: unknown) => new Response(JSON.stringify(body))
const isPoll = (input: RequestInfo | URL) => String(input).includes('/commands/next')
const makeOptions = (overrides: Partial<BridgeLoopOptions> = {}): BridgeLoopOptions => ({
  clientId: 'test-client',
  baseUrl: () => baseUrl,
  headers: () => ({authorization: 'HEADER_SECRET_MARKER'}),
  registration: () => ({token: 'BODY_SECRET_MARKER'}),
  execute: async () => undefined,
  fetch: vi.fn<typeof fetch>(async () => { throw new TypeError('ERROR_SECRET_MARKER') }),
  ...overrides,
})

let loop: BridgeLoop | null = null
const spyInfo = () => vi.spyOn(console, 'info').mockImplementation(() => undefined)
const spyWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined)
let info: ReturnType<typeof spyInfo>
let warn: ReturnType<typeof spyWarn>

beforeEach(() => {
  vi.useFakeTimers()
  info = spyInfo()
  warn = spyWarn()
})

afterEach(() => {
  loop?.stop()
  loop = null
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const reachQuietThreshold = async () => {
  for (const delay of [0, 1_000, 2_000, 4_000, 8_000]) {
    await vi.advanceTimersByTimeAsync(delay)
    expect(info).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  }
  await vi.advanceTimersByTimeAsync(16_000)
  await vi.waitFor(() => expect(info).toHaveBeenCalledTimes(1))
}

describe('bridge unavailable reason', () => {
  it('logs not paired once at the quiet threshold without fetching or warning', async () => {
    const options = makeOptions({
      headers: () => { throw new BridgeNotPairedError('PAIRING_SECRET_MARKER') },
    })
    loop = startBridgeLoop(options)

    await reachQuietThreshold()
    expect(info).toHaveBeenCalledWith(unavailable('registration: not paired'))
    await vi.advanceTimersByTimeAsync(180_000)
    expect(info).toHaveBeenCalledTimes(1)
    expect(options.fetch).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('reports registration HTTP 403 without response details and preserves the request error text', async () => {
    const options = makeOptions({fetch: vi.fn<typeof fetch>(async () =>
      new Response('RESPONSE_BODY_SECRET_MARKER', {status: 403, headers: {'x-detail': 'RESPONSE_HEADER_SECRET_MARKER'}}))})
    loop = startBridgeLoop(options)

    await reachQuietThreshold()
    expect(info).toHaveBeenCalledWith(unavailable('registration: HTTP 403'))
    await expect(loop.post('/test', {})).rejects.toThrow('Agent runtime bridge request failed: 403')
    expect(JSON.stringify(info.mock.calls)).not.toContain('SECRET_MARKER')
  })

  it('reports poll HTTP 500 once across quiet retries without a false reconnect', async () => {
    loop = startBridgeLoop(makeOptions({fetch: vi.fn<typeof fetch>(async input =>
      isPoll(input) ? new Response(null, {status: 500}) : jsonResponse({ok: true}))}))

    await reachQuietThreshold()
    expect(info).toHaveBeenCalledWith(unavailable('poll: HTTP 500'))
    await vi.advanceTimersByTimeAsync(180_000)
    expect(info).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('reports registration TypeError without message, stack, header, body, token or pairing URL contents', async () => {
    const error = new TypeError('ERROR_SECRET_MARKER http://bridge.test/?secret=PAIRING_SECRET_MARKER')
    error.stack = 'STACK_SECRET_MARKER'
    const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw error })
    loop = startBridgeLoop(makeOptions({fetch}))

    await reachQuietThreshold()
    expect(fetch).toHaveBeenCalledTimes(6)
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      headers: {authorization: 'HEADER_SECRET_MARKER'},
      body: JSON.stringify({token: 'BODY_SECRET_MARKER'}),
    })
    expect(info).toHaveBeenCalledWith(unavailable('registration: TypeError'))
    expect(JSON.stringify([...info.mock.calls, ...warn.mock.calls])).not.toContain('SECRET_MARKER')
    expect(warn).not.toHaveBeenCalled()
  })

  it('reports SyntaxError for a poll response that is not JSON', async () => {
    loop = startBridgeLoop(makeOptions({fetch: vi.fn<typeof fetch>(async input =>
      isPoll(input) ? new Response('NON_JSON_SECRET_MARKER') : jsonResponse({ok: true}))}))

    await reachQuietThreshold()
    expect(info).toHaveBeenCalledWith(unavailable('poll: SyntaxError'))
    expect(JSON.stringify(info.mock.calls)).not.toContain('SECRET_MARKER')
  })

  it.each([new Error('ERROR_SECRET_MARKER'), {name: 'TypeError', message: 'ERROR_SECRET_MARKER', status: 403}, null])(
    'reports other error for an unrecognized thrown value (%#)', async error => {
      loop = startBridgeLoop(makeOptions({fetch: vi.fn<typeof fetch>(async () => { throw error })}))

      await reachQuietThreshold()
      expect(info).toHaveBeenCalledWith(unavailable('registration: other error'))
      expect(JSON.stringify(info.mock.calls)).not.toContain('SECRET_MARKER')
    },
  )

  it('logs each changed reason in the quiet phase and deduplicates unchanged reasons', async () => {
    let status = 403
    loop = startBridgeLoop(makeOptions({fetch: vi.fn<typeof fetch>(async () => new Response(null, {status}))}))

    await reachQuietThreshold()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(info).toHaveBeenCalledTimes(1)
    status = 500
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(info).toHaveBeenCalledTimes(2))
    expect(info).toHaveBeenLastCalledWith(unavailable('registration: HTTP 500'))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(info).toHaveBeenCalledTimes(2)
    status = 403
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(info).toHaveBeenCalledTimes(3))
    expect(info).toHaveBeenLastCalledWith(unavailable('registration: HTTP 403'))
  })

  it('logs the same reason after a successful poll reconnects and a new outage reaches the threshold', async () => {
    let recover = false
    let pollStarted = false
    let rejectPoll!: (error: unknown) => void
    loop = startBridgeLoop(makeOptions({fetch: vi.fn<typeof fetch>(async input => {
      if (!recover) throw new TypeError('ERROR_SECRET_MARKER')
      if (!isPoll(input)) return jsonResponse({ok: true})
      if (!pollStarted) {
        pollStarted = true
        return jsonResponse(null)
      }
      return new Promise<Response>((_resolve, reject) => { rejectPoll = reject })
    })}))

    await reachQuietThreshold()
    expect(info).toHaveBeenCalledWith(unavailable('registration: TypeError'))
    recover = true
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(rejectPoll).toBeTypeOf('function'))
    expect(info).toHaveBeenCalledTimes(2)
    expect(info).toHaveBeenLastCalledWith(`Agent runtime bridge reconnected at ${baseUrl}.`)

    recover = false
    info.mockClear()
    rejectPoll(new TypeError('ERROR_SECRET_MARKER'))
    await reachQuietThreshold()
    expect(info).toHaveBeenCalledWith(unavailable('registration: TypeError'))
  })

  it('reports result HTTP 502 when invalid-command result reports repeatedly fail', async () => {
    loop = startBridgeLoop(makeOptions({fetch: vi.fn<typeof fetch>(async input => {
      if (isPoll(input)) return jsonResponse({type: 'unknown', commandId: 'test-command'})
      if (String(input).endsWith('/result')) return new Response(null, {status: 502})
      return jsonResponse({ok: true})
    })}))

    await reachQuietThreshold()
    expect(info).toHaveBeenCalledWith(unavailable('result: HTTP 502'))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(info).toHaveBeenCalledTimes(1)
  })

  it('stays silent when stop aborts an in-flight quiet retry', async () => {
    let hold = false
    let signal: AbortSignal | null | undefined
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      if (!hold) throw new TypeError('ERROR_SECRET_MARKER')
      signal = init?.signal
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {once: true})
      })
    })
    loop = startBridgeLoop(makeOptions({fetch}))

    await reachQuietThreshold()
    hold = true
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(7))
    info.mockClear()
    loop.stop()
    await vi.advanceTimersByTimeAsync(180_000)
    expect(signal?.aborted).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(7)
    expect(info).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })
})
