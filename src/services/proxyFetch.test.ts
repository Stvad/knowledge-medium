import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProxyHandler } from '../../supabase/functions/cors-proxy/proxy.ts'
import { ProxyFetchError, proxyFetch } from './proxyFetch'

const state = vi.hoisted(() => ({
  remoteSync: true,
  session: null as null | {access_token: string, user: {is_anonymous?: boolean}},
}))

vi.mock('@/data/repoProvider', () => ({isRemoteSyncActive: () => state.remoteSync}))
vi.mock('@/services/supabase', () => ({
  supabase: {auth: {getSession: async () => ({data: {session: state.session}})}},
  edgeFunctionEndpoint: (name: string) => ({url: `https://project.test/functions/v1/${name}`, apiKey: 'publishable-key'}),
}))

const PUBLIC_IP = '93.184.215.14'

/** The real proxy handler over a fake internet, standing in for the network. */
const proxyOver = (routes: Record<string, (req: Request) => Response>) => {
  const targetRequests: Request[] = []
  const handler = createProxyHandler({
    supabaseUrl: 'https://project.test',
    fetch: async (input, init) => {
      const req = new Request(input, init)
      if (req.url === 'https://project.test/auth/v1/user') {
        return req.headers.get('authorization') === 'Bearer user-token'
          ? Response.json({id: 'user-1', is_anonymous: false})
          : Response.json({msg: 'invalid JWT'}, {status: 401})
      }
      targetRequests.push(req)
      const route = routes[req.url]
      if (!route) throw new TypeError(`connection refused: ${req.url}`)
      return route(req)
    },
    resolveDns: async () => [PUBLIC_IP],
  })
  const wire = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await handler(new Request(input, init))
    // A network response body is a stream even when empty, which `new Response(null)` isn't.
    return new Response(response.body ?? '', {status: response.status, headers: response.headers})
  })
  vi.stubGlobal('fetch', wire)
  return {wire, targetRequests}
}

const refusal = (promise: Promise<unknown>) => promise.then(
  () => {
    throw new Error('expected a ProxyFetchError')
  },
  (error: unknown) => {
    expect(error).toBeInstanceOf(ProxyFetchError)
    return (error as ProxyFetchError).code
  },
)

beforeEach(() => {
  state.remoteSync = true
  state.session = {access_token: 'user-token', user: {is_anonymous: false}}
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('proxyFetch', () => {
  it('returns the target\'s response, final URL and redirects', async () => {
    proxyOver({
      'https://example.com/short': () => new Response(null, {status: 302, headers: {location: 'https://example.com/long'}}),
      'https://example.com/long': () => new Response('not here', {status: 404, headers: {'content-type': 'text/plain'}}),
    })
    const {response, url, redirects} = await proxyFetch('https://example.com/short')
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toBe('text/plain')
    expect(await response.text()).toBe('not here')
    expect(url).toBe('https://example.com/long')
    expect(redirects).toEqual([{status: 302, location: 'https://example.com/long'}])
  })

  it('sends the target the caller\'s headers and not the session', async () => {
    const {targetRequests} = proxyOver({'https://example.com/': () => new Response('ok')})
    await proxyFetch(new URL('https://example.com/'), {headers: {accept: 'application/json'}})
    expect([...targetRequests[0].headers]).toEqual([['accept', 'application/json']])
  })

  it('authenticates the proxy request with the session, not the publishable key', async () => {
    const {wire} = proxyOver({'https://example.com/': () => new Response('ok')})
    await proxyFetch('https://example.com/')
    const sent = new Headers(wire.mock.calls[0][1]!.headers)
    expect(sent.get('authorization')).toBe('Bearer user-token')
    expect(sent.get('apikey')).toBe('publishable-key')
  })

  it('makes HEAD requests', async () => {
    const {targetRequests} = proxyOver({'https://example.com/': () => new Response('body', {headers: {etag: '"v1"'}})})
    const {response} = await proxyFetch('https://example.com/', {method: 'HEAD'})
    expect(targetRequests[0].method).toBe('HEAD')
    expect(response.headers.get('etag')).toBe('"v1"')
  })

  it.each([204, 304])('returns a %i with no body', async status => {
    proxyOver({'https://example.com/': () => new Response(null, {status})})
    const {response} = await proxyFetch('https://example.com/')
    expect(response.status).toBe(status)
    expect(response.body).toBeNull()
  })

  it('rejects with the proxy\'s refusal', async () => {
    proxyOver({})
    expect(await refusal(proxyFetch('http://127.0.0.1/'))).toBe('blocked-address')
  })

  it('rejects when the answer is not the proxy\'s', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Function not found', {status: 404})))
    expect(await refusal(proxyFetch('https://example.com/'))).toBe('unreachable')
  })

  it('rejects when the proxy cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }))
    expect(await refusal(proxyFetch('https://example.com/'))).toBe('unreachable')
  })

  it('rejects with the caller\'s abort, as fetch does', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (_: unknown, init?: RequestInit) => {
      controller.abort()
      throw init!.signal!.reason
    }))
    await expect(proxyFetch('https://example.com/', {signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'})
  })

  describe('sends nothing', () => {
    it('from a local-only session', async () => {
      const {wire} = proxyOver({'https://example.com/': () => new Response('ok')})
      state.remoteSync = false
      expect(await refusal(proxyFetch('https://example.com/'))).toBe('local-only')
      expect(wire).not.toHaveBeenCalled()
    })

    it('without a session', async () => {
      const {wire} = proxyOver({'https://example.com/': () => new Response('ok')})
      state.session = null
      expect(await refusal(proxyFetch('https://example.com/'))).toBe('signed-out')
      expect(wire).not.toHaveBeenCalled()
    })

    it('from an anonymous session', async () => {
      const {wire} = proxyOver({'https://example.com/': () => new Response('ok')})
      state.session = {access_token: 'anonymous-token', user: {is_anonymous: true}}
      expect(await refusal(proxyFetch('https://example.com/'))).toBe('anonymous-session')
      expect(wire).not.toHaveBeenCalled()
    })
  })
})
