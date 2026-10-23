import { afterEach, describe, expect, it, vi } from 'vitest'
import { runBridgeHealthProbe } from '../bridgeHealthProbe.ts'

const configuredBridge = 'http://127.0.0.1:8787'
const okResponse = (body: unknown = {ok: true}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: {'content-type': 'application/json'},
  })

const makeOptions = (overrides: Partial<Parameters<typeof runBridgeHealthProbe>[0]> = {}) => ({
  getBridgeUrl: () => configuredBridge,
  mode: 'standard' as const,
  fetchFn: vi.fn<typeof fetch>(async () => okResponse()),
  permissionQuery: vi.fn<(name: 'loopback-network') => Promise<{state: string}>>(async () => ({state: 'granted'})),
  ...overrides,
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('runBridgeHealthProbe', () => {
  it('probes only the configured bridge origin /health with minimal standard fetch options', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => okResponse({ok: true, token: 'BODY_SECRET_MARKER'}))
    const permissionQuery = vi.fn<(name: 'loopback-network') => Promise<{state: string}>>(async () => ({state: 'granted'}))

    const result = await runBridgeHealthProbe(makeOptions({fetchFn, permissionQuery}))

    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [input, init] = fetchFn.mock.calls[0]!
    expect(String(input)).toBe(`${configuredBridge}/health`)
    expect(init).toMatchObject({
      credentials: 'omit',
      redirect: 'error',
    })
    expect(init?.headers).toBeUndefined()
    expect(init?.body).toBeUndefined()
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(init).not.toHaveProperty('targetAddressSpace')
    expect(permissionQuery).toHaveBeenCalledTimes(1)
    expect(permissionQuery).toHaveBeenCalledWith('loopback-network')
    expect(result.loopbackPermission).toBe('granted')
    expect(result).toMatchObject({
      mode: 'standard',
      status: 200,
      bodyOk: true,
    })
    expect(Object.keys(result).sort()).toEqual([
      'bodyOk', 'finishedAt', 'loopbackPermission', 'mode', 'startedAt', 'status',
    ])
    expect(Date.parse(result.startedAt)).not.toBeNaN()
    expect(Date.parse(result.finishedAt)).not.toBeNaN()
    expect(Date.parse(result.finishedAt)).toBeGreaterThanOrEqual(Date.parse(result.startedAt))
    expect(JSON.stringify(result)).not.toContain('BODY_SECRET_MARKER')
  })

  it('uses targetAddressSpace loopback only when the explicit loopback mode is run', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => okResponse())
    const permissionQuery = vi.fn(async (name: string) => {
      expect(fetchFn).toHaveBeenCalledTimes(1)
      return {state: name === 'loopback-network' ? 'granted' : 'denied'}
    })

    const result = await runBridgeHealthProbe(makeOptions({
      mode: 'loopback',
      fetchFn,
      permissionQuery,
    }))

    const [input, init] = fetchFn.mock.calls[0]!
    expect(String(input)).toBe(`${configuredBridge}/health`)
    expect(init).toMatchObject({
      credentials: 'omit',
      redirect: 'error',
      targetAddressSpace: 'loopback',
    })
    expect(init?.headers).toBeUndefined()
    expect(init?.body).toBeUndefined()
    expect(permissionQuery).toHaveBeenCalledTimes(1)
    expect(permissionQuery).toHaveBeenCalledWith('loopback-network')
    expect(result.loopbackPermission).toBe('granted')
  })

  it('uses the injected clock for matching start and finish timestamps', async () => {
    const clock = vi.fn()
      .mockReturnValueOnce(new Date('2026-10-20T03:00:00.000Z'))
      .mockReturnValueOnce(new Date('2026-10-20T03:00:00.250Z'))

    const result = await runBridgeHealthProbe(makeOptions({now: clock}))

    expect(clock).toHaveBeenCalledTimes(2)
    expect(result.startedAt).toBe('2026-10-20T03:00:00.000Z')
    expect(result.finishedAt).toBe('2026-10-20T03:00:00.250Z')
  })

  it('starts the loopback fetch before awaiting the permission query', async () => {
    let resolvePermission!: (result: {state: string}) => void
    const pendingPermission = new Promise<{state: string}>(resolve => {
      resolvePermission = resolve
    })
    const fetchFn = vi.fn<typeof fetch>(async () => okResponse())
    const permissionQuery = vi.fn<(name: 'loopback-network') => Promise<{state: string}>>((name) => {
      expect(name).toBe('loopback-network')
      expect(fetchFn).toHaveBeenCalledTimes(1)
      return pendingPermission
    })

    const resultPromise = runBridgeHealthProbe(makeOptions({
      mode: 'loopback',
      fetchFn,
      permissionQuery,
    }))

    expect(fetchFn).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(permissionQuery).toHaveBeenCalledTimes(1))
    resolvePermission({state: 'prompt'})
    await expect(resultPromise).resolves.toMatchObject({loopbackPermission: 'prompt'})
  })

  it.each([
    ['non-loopback host', 'https://bridge.attacker.example'],
    ['userinfo even on loopback', 'http://user:URL_SECRET_MARKER@127.0.0.1:8787'],
  ])('refuses %s before any request', async (_description, configuredUrl) => {
    const fetchFn = vi.fn<typeof fetch>(async () => okResponse())
    const permissionQuery = vi.fn<(name: 'loopback-network') => Promise<{state: string}>>(async () => ({state: 'granted'}))
    const result = await runBridgeHealthProbe(makeOptions({
      mode: 'loopback',
      getBridgeUrl: () => configuredUrl,
      fetchFn,
      permissionQuery,
    }))

    expect(fetchFn).not.toHaveBeenCalled()
    expect(permissionQuery).toHaveBeenCalledWith('loopback-network')
    expect(result.status).toBeNull()
    expect(result.bodyOk).toBe(false)
    expect(JSON.stringify(result)).not.toContain(configuredUrl)
    expect(JSON.stringify(result)).not.toContain('URL_SECRET_MARKER')
  })

  it('strips configured path, query, and fragment without forwarding their contents', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => okResponse({ok: true, secret: 'BODY_SECRET_MARKER'}))
    const configuredUrl = `${configuredBridge}/private/path?token=QUERY_SECRET_MARKER#HASH_SECRET_MARKER`

    const result = await runBridgeHealthProbe(makeOptions({
      mode: 'loopback',
      getBridgeUrl: () => configuredUrl,
      fetchFn,
    }))

    expect(String(fetchFn.mock.calls[0]?.[0])).toBe(`${configuredBridge}/health`)
    expect(JSON.stringify(fetchFn.mock.calls)).not.toContain('QUERY_SECRET_MARKER')
    expect(JSON.stringify(fetchFn.mock.calls)).not.toContain('HASH_SECRET_MARKER')
    expect(JSON.stringify(result)).not.toContain('BODY_SECRET_MARKER')
  })

  it('keeps a completed read-only permission result when the health request fails first', async () => {
    let resolvePermission!: (result: {state: string}) => void
    const pendingPermission = new Promise<{state: string}>(resolve => {
      resolvePermission = resolve
    })
    const fetchFn = vi.fn<typeof fetch>(async () => { throw new TypeError('fetch failed: FETCH_SECRET_MARKER') })
    const permissionQuery = vi.fn<(name: 'loopback-network') => Promise<{state: string}>>(() => pendingPermission)
    let settled = false
    const resultPromise = runBridgeHealthProbe(makeOptions({fetchFn, permissionQuery}))
      .then(result => { settled = true; return result })

    await vi.waitFor(() => expect(permissionQuery).toHaveBeenCalledWith('loopback-network'))
    await Promise.resolve()
    expect(settled).toBe(false)
    resolvePermission({state: 'granted'})
    const result = await resultPromise

    expect(result.loopbackPermission).toBe('granted')
    expect(result.error).toEqual({name: 'TypeError', category: 'network-error'})
    expect(JSON.stringify(result)).not.toContain('FETCH_SECRET_MARKER')
  })

  it('reports unsupported loopback permission queries without failing the health probe', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => okResponse())
    const permissionQuery = vi.fn<(name: 'loopback-network') => Promise<{state: string}>>(async () => {
      throw new TypeError('permission API unsupported: PERMISSION_SECRET_MARKER')
    })

    const result = await runBridgeHealthProbe(makeOptions({
      mode: 'loopback',
      fetchFn,
      permissionQuery,
    }))

    expect(permissionQuery).toHaveBeenCalledTimes(1)
    expect(permissionQuery).toHaveBeenCalledWith('loopback-network')
    expect(result).toMatchObject({status: 200, bodyOk: true, loopbackPermission: 'unsupported'})
    expect(JSON.stringify(result)).not.toContain('PERMISSION_SECRET_MARKER')
  })

  it('aborts a hung request at the configured timeout', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const fetchFn = vi.fn<typeof fetch>((input, init) => {
      expect(String(input)).toBe(`${configuredBridge}/health`)
      signal = init?.signal ?? undefined
      return new Promise<Response>(() => undefined)
    })
    const resultPromise = runBridgeHealthProbe(makeOptions({
      fetchFn,
      timeoutMs: 25,
    }))

    await vi.advanceTimersByTimeAsync(25)
    const result = await resultPromise

    expect(signal?.aborted).toBe(true)
    expect(result.error).toEqual({name: 'TimeoutError', category: 'timeout'})
  })

  it('bounds probe errors to allowlisted fields and handles a throwing error-name getter', async () => {
    const error = Object.defineProperty(new Error('FETCH_SECRET_MARKER'), 'name', {
      get: () => { throw new Error('NAME_SECRET_MARKER') },
    })
    const fetchFn = vi.fn<typeof fetch>(async () => { throw error })

    const result = await runBridgeHealthProbe(makeOptions({fetchFn}))

    expect(result.status).toBeNull()
    expect(result.bodyOk).toBe(false)
    expect(result.error).toBeDefined()
    expect(Object.keys(result.error!).sort()).toEqual(['category', 'name'])
    expect(result.error).toEqual({name: 'UnknownError', category: 'unexpected-error'})
    expect(JSON.stringify(result)).not.toContain('FETCH_SECRET_MARKER')
    expect(JSON.stringify(result)).not.toContain('NAME_SECRET_MARKER')
  })
})
