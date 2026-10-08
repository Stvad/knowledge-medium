import { AuthError, AuthRetryableFetchError } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProxyHandler } from '../../supabase/functions/cors-proxy/proxy.ts'
import { fakeNetwork, PUBLIC_IP, type Route, SUPABASE_URL } from '../../supabase/functions/cors-proxy/testNetwork.ts'
import { proxyFetch } from './proxyFetch'

const state = vi.hoisted(() => ({
  remoteSync: true,
  session: null as null | {access_token: string, user: {is_anonymous?: boolean}},
  sessionError: null as unknown,
  sessionThrows: null as unknown,
  sessionPending: false,
}))

vi.mock('@/data/repoProvider', () => ({isRemoteSyncActive: () => state.remoteSync}))
vi.mock('@/services/supabase', () => ({
  supabase: {auth: {getSession: async () => {
    if (state.sessionPending) return new Promise(() => {})
    if (state.sessionThrows) throw state.sessionThrows
    return {data: {session: state.session}, error: state.sessionError}
  }}},
  edgeFunctionEndpoint: (name: string) => ({url: `${SUPABASE_URL}/functions/v1/${name}`, apiKey: 'publishable-key'}),
}))

/** The real proxy handler over a fake internet, standing in for the network. */
const proxyOver = (routes: Record<string, Route>) => {
  const network = fakeNetwork(routes, {'example.com': [PUBLIC_IP], 'ja.wikipedia.org': [PUBLIC_IP]})
  const handler = createProxyHandler({supabaseUrl: SUPABASE_URL, fetch: network.fetch, resolveDns: network.resolveDns})
  const wire = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await handler(new Request(input, init))
    // A network response body is a stream even when empty, which `new Response(null)` isn't.
    return new Response(response.body ?? '', {status: response.status, headers: response.headers})
  })
  vi.stubGlobal('fetch', wire)
  return {wire, targetRequests: network.targetRequests}
}

const refusedWith = (code: string) => expect.objectContaining({name: 'ProxyFetchError', code})

beforeEach(() => {
  state.remoteSync = true
  state.session = {access_token: 'user-token', user: {is_anonymous: false}}
  state.sessionError = null
  state.sessionThrows = null
  state.sessionPending = false
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
    expect([...targetRequests()[0].headers]).toEqual([['accept', 'application/json']])
  })

  it('authenticates the proxy request with the session, not the publishable key', async () => {
    const {wire} = proxyOver({'https://example.com/': () => new Response('ok')})
    await proxyFetch('https://example.com/')
    const sent = new Headers(wire.mock.calls[0][1]!.headers)
    expect(sent.get('authorization')).toBe('Bearer user-token')
    expect(sent.get('apikey')).toBe('publishable-key')
  })

  it('sends a URL with characters a header can\'t carry, encoded', async () => {
    const {targetRequests} = proxyOver({'https://ja.wikipedia.org/wiki/%E6%9D%B1%E4%BA%AC': () => new Response('ok')})
    const {response} = await proxyFetch('https://ja.wikipedia.org/wiki/東京')
    expect(await response.text()).toBe('ok')
    expect(targetRequests()).toHaveLength(1)
  })

  it('makes HEAD requests', async () => {
    const {targetRequests} = proxyOver({'https://example.com/': () => new Response('body', {headers: {etag: '"v1"'}})})
    const {response} = await proxyFetch('https://example.com/', {method: 'HEAD'})
    expect(targetRequests()[0].method).toBe('HEAD')
    expect(response.headers.get('etag')).toBe('"v1"')
  })

  it.each([204, 304])('returns a %i with no body', async status => {
    proxyOver({'https://example.com/': () => new Response(null, {status})})
    const {response} = await proxyFetch('https://example.com/')
    expect(response.status).toBe(status)
    expect(response.body).toBeNull()
  })

  it('rejects with the proxy\'s refusal, and the redirects followed before it', async () => {
    proxyOver({'https://example.com/': () => new Response(null, {status: 302, headers: {location: 'http://127.0.0.1/'}})})
    await expect(proxyFetch('https://example.com/')).rejects.toEqual(expect.objectContaining({
      code: 'blocked-address',
      redirects: [{status: 302, location: 'http://127.0.0.1/'}],
    }))
  })

  it('rejects when the answer is not the proxy\'s', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Function not found', {status: 404})))
    await expect(proxyFetch('https://example.com/')).rejects.toEqual(refusedWith('unreachable'))
  })

  it('reports a refusal code this client doesn\'t know as unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {status: 502, headers: {'x-proxy-error': 'from-a-newer-proxy'}})))
    await expect(proxyFetch('https://example.com/')).rejects.toEqual(refusedWith('unreachable'))
  })

  it('rejects when the proxy cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }))
    await expect(proxyFetch('https://example.com/')).rejects.toEqual(refusedWith('unreachable'))
  })

  it('rejects with the caller\'s abort, as fetch does', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (_: unknown, init?: RequestInit) => {
      controller.abort()
      throw init!.signal!.reason
    }))
    await expect(proxyFetch('https://example.com/', {signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'})
  })

  it('rejects with the caller\'s abort while the session is still refreshing, sending nothing', async () => {
    const {wire} = proxyOver({'https://example.com/': () => new Response('ok')})
    state.sessionPending = true
    const controller = new AbortController()
    const pending = proxyFetch('https://example.com/', {signal: controller.signal})
    controller.abort()
    await expect(pending).rejects.toMatchObject({name: 'AbortError'})
    expect(wire).not.toHaveBeenCalled()
  })

  it('rejects with the caller\'s abort while a refusal is still arriving', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      new ReadableStream({start: stream => {
        controller.signal.addEventListener('abort', () => stream.error(controller.signal.reason))
      }}),
      {status: 403, headers: {'x-proxy-error': 'blocked-address'}},
    )))
    const pending = proxyFetch('https://example.com/', {signal: controller.signal})
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    controller.abort()
    await expect(pending).rejects.toMatchObject({name: 'AbortError'})
  })

  describe('sends nothing', () => {
    it.each([
      ['for a URL that isn\'t absolute', '/relative', () => {}, 'invalid-url'],
      ['for a URL that isn\'t http(s)', 'ftp://example.com/file', () => {}, 'invalid-url'],
      ['for a URL carrying credentials', 'https://user:secret@example.com/', () => {}, 'invalid-url'],
      ['from a local-only session', 'https://example.com/', () => {
        state.remoteSync = false
      }, 'local-only'],
      ['without a session', 'https://example.com/', () => {
        state.session = null
      }, 'signed-out'],
      ['when the session can\'t be refreshed for now', 'https://example.com/', () => {
        state.session = null
        state.sessionError = new AuthRetryableFetchError('Failed to fetch', 0)
      }, 'unreachable'],
      ['when Auth rejects the refresh, which signs the user out', 'https://example.com/', () => {
        state.session = null
        state.sessionError = new AuthError('Invalid Refresh Token: Refresh Token Not Found', 400)
      }, 'signed-out'],
      ['when refreshing the session throws', 'https://example.com/', () => {
        state.sessionThrows = new TypeError('Failed to fetch')
      }, 'unreachable'],
      ['from an anonymous session', 'https://example.com/', () => {
        state.session = {access_token: 'anonymous-token', user: {is_anonymous: true}}
      }, 'anonymous-session'],
    ])('%s', async (_, url, arrange, code) => {
      const {wire} = proxyOver({'https://example.com/': () => new Response('ok')})
      arrange()
      await expect(proxyFetch(url)).rejects.toEqual(refusedWith(code))
      expect(wire).not.toHaveBeenCalled()
    })
  })
})
