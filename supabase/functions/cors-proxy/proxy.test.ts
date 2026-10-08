import { describe, expect, it } from 'vitest'
import { createProxyHandler, DEFAULT_LIMITS, isPublicAddress, type ProxyLimits } from './proxy.ts'

const SUPABASE_URL = 'https://project.test'
const AUTH_URL = `${SUPABASE_URL}/auth/v1/user`
const PROXY_ENDPOINT = `${SUPABASE_URL}/functions/v1/cors-proxy`

type Route = (req: Request) => Response | Promise<Response>

const authRoute: Route = req => {
  switch (req.headers.get('authorization')) {
    case 'Bearer user-token': return Response.json({id: 'user-1', is_anonymous: false})
    case 'Bearer anonymous-token': return Response.json({id: 'user-2', is_anonymous: true})
    default: return Response.json({msg: 'invalid JWT'}, {status: 401})
  }
}

/** A fake internet: exact-URL routes, plus the project's Auth. Records every request. */
const setup = (
  routes: Record<string, Route>,
  dns: Record<string, string[]> = {},
  limits: ProxyLimits = DEFAULT_LIMITS,
) => {
  const requests: Request[] = []
  const lookups: string[] = []
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init)
    requests.push(req)
    // Routed like a server with virtual hosts: by the Host header when one is sent.
    const addressed = new URL(req.url)
    const host = req.headers.get('host')
    if (host) addressed.host = host
    const route = addressed.href === AUTH_URL ? (routes[AUTH_URL] ?? authRoute) : routes[addressed.href]
    if (!route) throw new TypeError(`connection refused: ${addressed.href}`)
    const response = await route(req)
    // Like real fetch: follows a redirect itself unless told not to.
    const location = response.headers.get('location')
    if (req.redirect !== 'manual' && location && response.status >= 300 && response.status < 400) {
      return fetch(new URL(location, req.url), init)
    }
    return response
  }
  const handler = createProxyHandler({
    supabaseUrl: SUPABASE_URL,
    fetch,
    resolveDns: async hostname => {
      lookups.push(hostname)
      return dns[hostname] ?? []
    },
    limits,
  })
  const call = (target: string | null, options: {
    method?: string
    token?: string | null
    headers?: Record<string, string>
    origin?: string
  } = {}) => {
    const headers = new Headers({apikey: 'publishable-key', ...options.headers})
    const token = options.token === undefined ? 'user-token' : options.token
    if (token) headers.set('authorization', `Bearer ${token}`)
    if (target !== null) headers.set('x-proxy-url', target)
    if (options.origin) headers.set('origin', options.origin)
    return handler(new Request(PROXY_ENDPOINT, {method: options.method ?? 'GET', headers}))
  }
  const targetRequests = () => requests.filter(req => req.url !== AUTH_URL)
  return {call, handler, requests, targetRequests, lookups}
}

const PUBLIC_IP = '93.184.215.14'
const PUBLIC_DNS = {'example.com': [PUBLIC_IP], 'other.example': [PUBLIC_IP]}

const errorOf = async (response: Response) => ({
  status: response.status,
  code: response.headers.get('x-proxy-error'),
})

describe('isPublicAddress', () => {
  it.each([
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '100.100.100.200', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '172.31.255.255', '192.0.0.192', '192.0.2.1', '192.168.1.1', '198.18.0.1',
    '198.51.100.7', '203.0.113.9', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fd00:ec2::254', 'fe80::1', 'fec0::1', 'ff02::1', '100::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::a9fe:a9fe', '2002:7f00:1::',
    '::127.0.0.1', '2001:db8::1', '2001::1', '3fff::1',
    'not-an-ip', '1.2.3', '1.2.3.256', '1::2::3', '12345::', '2606:4700:1', '2606::1:2:3:4:5:6:7',
  ])('refuses %s', address => {
    expect(isPublicAddress(address)).toBe(false)
  })

  it.each([
    '8.8.8.8', PUBLIC_IP, '172.32.0.1', '100.128.0.1', '2001:4860:4860::8888', '2606:4700::1111',
    '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::',
  ])('accepts %s', address => {
    expect(isPublicAddress(address)).toBe(true)
  })
})

describe('authentication', () => {
  const routes = {'https://example.com/': () => new Response('ok')}

  it('refuses a caller with no session, before fetching anything', async () => {
    const {call, requests} = setup(routes, PUBLIC_DNS)
    expect(await errorOf(await call('https://example.com/', {token: null}))).toEqual({status: 401, code: 'unauthenticated'})
    expect(requests).toEqual([])
  })

  it('refuses a token Auth rejects, such as the publishable key', async () => {
    const {call, targetRequests} = setup(routes, PUBLIC_DNS)
    expect(await errorOf(await call('https://example.com/', {token: 'publishable-key'}))).toEqual({status: 401, code: 'unauthenticated'})
    expect(targetRequests()).toEqual([])
  })

  it('refuses an anonymous session', async () => {
    const {call, targetRequests} = setup(routes, PUBLIC_DNS)
    expect(await errorOf(await call('https://example.com/', {token: 'anonymous-token'}))).toEqual({status: 403, code: 'anonymous-session'})
    expect(targetRequests()).toEqual([])
  })

  it('refuses when Auth answers without a user', async () => {
    const {call, targetRequests} = setup({...routes, [AUTH_URL]: () => Response.json({})}, PUBLIC_DNS)
    expect(await errorOf(await call('https://example.com/'))).toEqual({status: 401, code: 'unauthenticated'})
    expect(targetRequests()).toEqual([])
  })

  it('fails closed when Auth is unreachable', async () => {
    const {call, targetRequests} = setup({...routes, [AUTH_URL]: () => { throw new TypeError('connection reset') }}, PUBLIC_DNS)
    expect(await errorOf(await call('https://example.com/'))).toEqual({status: 503, code: 'auth-unavailable'})
    expect(targetRequests()).toEqual([])
  })

  it('authenticates before validating the request', async () => {
    const {call} = setup({}, PUBLIC_DNS)
    expect(await errorOf(await call('file:///etc/passwd', {token: null}))).toEqual({status: 401, code: 'unauthenticated'})
  })

  it('fails closed when Auth is down', async () => {
    const {call, targetRequests} = setup({...routes, [AUTH_URL]: () => new Response('', {status: 502})}, PUBLIC_DNS)
    expect(await errorOf(await call('https://example.com/'))).toEqual({status: 503, code: 'auth-unavailable'})
    expect(targetRequests()).toEqual([])
  })

  it('checks the session with the caller\'s own credentials', async () => {
    const {call, requests} = setup(routes, PUBLIC_DNS)
    await call('https://example.com/')
    const auth = requests.find(req => req.url === AUTH_URL)!
    expect(auth.headers.get('authorization')).toBe('Bearer user-token')
    expect(auth.headers.get('apikey')).toBe('publishable-key')
  })
})

describe('request', () => {
  it('fetches the target and relays its status, headers and body', async () => {
    const {call} = setup({
      'https://example.com/missing': () => new Response('nope', {status: 404, headers: {'content-type': 'text/plain', 'x-request-id': 'r1'}}),
    }, PUBLIC_DNS)
    const response = await call('https://example.com/missing')
    expect(response.status).toBe(200)
    expect(response.headers.get('x-proxy-status')).toBe('404')
    expect(response.headers.get('x-proxy-final-url')).toBe('https://example.com/missing')
    expect(response.headers.get('x-proxy-header-content-type')).toBe('text/plain')
    expect(response.headers.get('x-proxy-header-x-request-id')).toBe('r1')
    expect(response.headers.get('content-type')).toBeNull()
    expect(await response.text()).toBe('nope')
  })

  it('sends the target only the headers addressed to it', async () => {
    const {call, targetRequests} = setup({'https://example.com/': () => new Response('ok')}, PUBLIC_DNS)
    await call('https://example.com/', {headers: {
      'x-client-info': 'supabase-js',
      'x-proxy-header-accept': 'application/json',
      'x-proxy-header-authorization': 'Bearer third-party-key',
    }})
    const [target] = targetRequests()
    expect([...target.headers]).toEqual([
      ['accept', 'application/json'],
      ['authorization', 'Bearer third-party-key'],
    ])
  })

  it.each(['cookie', 'host', 'proxy-authorization', 'transfer-encoding'])('refuses to send %s to a target', async name => {
    const {call, targetRequests} = setup({'https://example.com/': () => new Response('ok')}, PUBLIC_DNS)
    expect(await errorOf(await call('https://example.com/', {headers: {[`x-proxy-header-${name}`]: 'x'}})))
      .toEqual({status: 400, code: 'forbidden-header'})
    expect(targetRequests()).toEqual([])
  })

  it.each([
    ['missing', null],
    ['relative', '/path'],
    ['not http', 'file:///etc/passwd'],
    ['carrying credentials', 'https://user:pass@example.com/'],
  ])('refuses a target URL that is %s', async (_, target) => {
    const {call, targetRequests} = setup({}, PUBLIC_DNS)
    expect(await errorOf(await call(target))).toEqual({status: 400, code: 'invalid-url'})
    expect(targetRequests()).toEqual([])
  })

  it.each(['POST', 'PUT', 'DELETE'])('refuses %s', async method => {
    const {call, requests} = setup({'https://example.com/': () => new Response('ok')}, PUBLIC_DNS)
    expect(await errorOf(await call('https://example.com/', {method}))).toEqual({status: 405, code: 'method-not-allowed'})
    expect(requests).toEqual([])
  })

  it('sends HEAD as HEAD and relays no body', async () => {
    const {call, targetRequests} = setup({'https://example.com/': () => new Response('body', {headers: {'content-type': 'text/html'}})}, PUBLIC_DNS)
    const response = await call('https://example.com/', {method: 'HEAD'})
    expect(targetRequests()[0].method).toBe('HEAD')
    expect(response.headers.get('x-proxy-header-content-type')).toBe('text/html')
    expect(response.body).toBeNull()
  })
})

describe('addresses', () => {
  it.each([
    'http://127.0.0.1/', 'http://0x7f.1/', 'http://2130706433/', 'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://10.0.0.1:8080/',
  ])('refuses the literal address %s without resolving anything', async target => {
    const {call, targetRequests, lookups} = setup({}, PUBLIC_DNS)
    expect(await errorOf(await call(target))).toEqual({status: 403, code: 'blocked-address'})
    expect(targetRequests()).toEqual([])
    expect(lookups).toEqual([])
  })

  it.each(['http://8.8.8.8/', 'http://[2606:4700::1111]/'])('accepts the public literal address %s', async target => {
    const {call} = setup({[target]: () => new Response('ok')})
    expect((await call(target)).headers.get('x-proxy-status')).toBe('200')
  })

  it('refuses a name that resolves to a private address', async () => {
    const {call, targetRequests} = setup({}, {'internal.example.com': ['10.0.0.5']})
    expect(await errorOf(await call('https://internal.example.com/'))).toEqual({status: 403, code: 'blocked-address'})
    expect(targetRequests()).toEqual([])
  })

  it('refuses a name when any of its records is private', async () => {
    const {call, targetRequests} = setup({}, {'mixed.example.com': [PUBLIC_IP, '::1']})
    expect(await errorOf(await call('https://mixed.example.com/'))).toEqual({status: 403, code: 'blocked-address'})
    expect(targetRequests()).toEqual([])
  })

  // DNS says public here; these are refused by name alone, because the resolver
  // fetch uses can answer differently for them.
  it.each(['http://localhost/', 'http://localhost./', 'http://app.localhost/', 'http://metadata/', 'http://printer.local/', 'http://metadata.google.internal/', 'http://nas.home.arpa/'])(
    'refuses the local name %s',
    async target => {
      const host = new URL(target).hostname.replace(/\.$/, '')
      const {call, targetRequests} = setup({[target]: () => new Response('ok')}, {[host]: [PUBLIC_IP]})
      expect(await errorOf(await call(target))).toEqual({status: 403, code: 'blocked-address'})
      expect(targetRequests()).toEqual([])
    },
  )

  it('connects an http target to the address it checked, so the name is not resolved again', async () => {
    const {call, targetRequests} = setup(
      {'http://example.com:8080/page?q=1': () => new Response('ok')},
      {'example.com': ['2606:4700::1111', PUBLIC_IP]},
    )
    const response = await call('http://example.com:8080/page?q=1')
    expect(await response.text()).toBe('ok')
    expect(response.headers.get('x-proxy-final-url')).toBe('http://example.com:8080/page?q=1')
    const [target] = targetRequests()
    expect([target.url, target.headers.get('host')]).toEqual([`http://${PUBLIC_IP}:8080/page?q=1`, 'example.com:8080'])
  })

  it('connects an https target by name, for its certificate check', async () => {
    const {call, targetRequests} = setup({'https://example.com/page': () => new Response('ok')}, PUBLIC_DNS)
    await call('https://example.com/page')
    const [target] = targetRequests()
    expect([target.url, target.headers.get('host')]).toEqual(['https://example.com/page', null])
  })

  it('reports a name that does not resolve', async () => {
    const {call, targetRequests} = setup({})
    expect(await errorOf(await call('https://nowhere.example/'))).toEqual({status: 502, code: 'unresolvable'})
    expect(targetRequests()).toEqual([])
  })
})

describe('redirects', () => {
  const redirect = (location: string, status = 302): Route => () => new Response(null, {status, headers: {location}})

  it('follows redirects and reports every hop, relative ones made absolute', async () => {
    const {call} = setup({
      'https://example.com/short': redirect('https://other.example/long?q=1', 301),
      'https://other.example/long?q=1': redirect('/final'),
      'https://other.example/final': () => new Response('done'),
    }, PUBLIC_DNS)
    const response = await call('https://example.com/short')
    expect(response.headers.get('x-proxy-redirect-1')).toBe('301 https://other.example/long?q=1')
    expect(response.headers.get('x-proxy-redirect-2')).toBe('302 https://other.example/final')
    expect(response.headers.get('x-proxy-redirect-3')).toBeNull()
    expect(response.headers.get('x-proxy-final-url')).toBe('https://other.example/final')
    expect(await response.text()).toBe('done')
  })

  it('names the host only on the http hop it connects', async () => {
    const {call, targetRequests} = setup({
      'http://example.com/a': redirect('https://other.example/b'),
      'https://other.example/b': () => new Response('ok'),
    }, PUBLIC_DNS)
    expect(await (await call('http://example.com/a')).text()).toBe('ok')
    expect(targetRequests().map(req => req.headers.get('host'))).toEqual(['example.com', null])
  })

  it('refuses a redirect to an internal address without connecting to it', async () => {
    const {call, targetRequests} = setup({
      'https://example.com/': redirect('http://169.254.169.254/latest/meta-data/'),
      'http://169.254.169.254/latest/meta-data/': () => new Response('secrets'),
    }, PUBLIC_DNS)
    const response = await call('https://example.com/')
    expect(await errorOf(response)).toEqual({status: 403, code: 'blocked-address'})
    expect(response.headers.get('x-proxy-redirect-1')).toBe('302 http://169.254.169.254/latest/meta-data/')
    expect(targetRequests().map(req => req.url)).toEqual(['https://example.com/'])
  })

  it('refuses a redirect to a name that resolves internally', async () => {
    const {call, targetRequests} = setup({
      'https://example.com/': redirect('https://rebind.example.net/'),
      'https://rebind.example.net/': () => new Response('internal'),
    }, {...PUBLIC_DNS, 'rebind.example.net': ['127.0.0.1']})
    expect(await errorOf(await call('https://example.com/'))).toEqual({status: 403, code: 'blocked-address'})
    expect(targetRequests().map(req => req.url)).toEqual(['https://example.com/'])
  })

  it('refuses a redirect out of http(s)', async () => {
    const {call} = setup({'https://example.com/': redirect('file:///etc/passwd')}, PUBLIC_DNS)
    expect(await errorOf(await call('https://example.com/'))).toEqual({status: 502, code: 'bad-redirect'})
  })

  it('gives up past the hop cap', async () => {
    const limits = {...DEFAULT_LIMITS, maxRedirects: 2}
    const {call, targetRequests} = setup({
      'https://example.com/1': redirect('/2'),
      'https://example.com/2': redirect('/3'),
      'https://example.com/3': redirect('/4'),
      'https://example.com/4': () => new Response('too far'),
    }, PUBLIC_DNS, limits)
    expect(await errorOf(await call('https://example.com/1'))).toEqual({status: 502, code: 'too-many-redirects'})
    expect(targetRequests()).toHaveLength(3)
  })

  it('follows exactly the hop cap', async () => {
    const limits = {...DEFAULT_LIMITS, maxRedirects: 2}
    const {call} = setup({
      'https://example.com/1': redirect('/2'),
      'https://example.com/2': redirect('/3'),
      'https://example.com/3': () => new Response('arrived'),
    }, PUBLIC_DNS, limits)
    expect(await (await call('https://example.com/1')).text()).toBe('arrived')
  })

  it('keeps the caller\'s target Authorization on the same origin and drops it on another', async () => {
    const {call, targetRequests} = setup({
      'https://example.com/a': redirect('/b'),
      'https://example.com/b': redirect('https://other.example/c'),
      'https://other.example/c': () => new Response('ok'),
    }, PUBLIC_DNS)
    await call('https://example.com/a', {headers: {'x-proxy-header-authorization': 'Bearer key', 'x-proxy-header-accept': 'text/plain'}})
    expect(targetRequests().map(req => [req.url, req.headers.get('authorization'), req.headers.get('accept')])).toEqual([
      ['https://example.com/a', 'Bearer key', 'text/plain'],
      ['https://example.com/b', 'Bearer key', 'text/plain'],
      ['https://other.example/c', null, 'text/plain'],
    ])
  })

  it('relays a 3xx with no Location as the final response', async () => {
    const {call} = setup({'https://example.com/': () => new Response(null, {status: 304})}, PUBLIC_DNS)
    const response = await call('https://example.com/')
    expect(response.headers.get('x-proxy-status')).toBe('304')
    expect(response.body).toBeNull()
  })
})

describe('response', () => {
  it('relays no cookies and no framing that no longer matches the body', async () => {
    const {call} = setup({
      'https://example.com/': () => {
        const headers = new Headers({'content-encoding': 'gzip', 'content-length': '3', 'content-type': 'text/plain'})
        headers.append('set-cookie', 'session=secret')
        return new Response('abc', {headers})
      },
    }, PUBLIC_DNS)
    const response = await call('https://example.com/')
    const relayed = [...response.headers.keys()].filter(name => name.startsWith('x-proxy-header-'))
    expect(relayed).toEqual(['x-proxy-header-content-type'])
  })

  it('namespaces target headers so they cannot pose as the proxy\'s own', async () => {
    const {call} = setup({
      'https://example.com/': () => new Response('ok', {headers: {
        'x-proxy-final-url': 'https://evil.example/',
        'access-control-allow-origin': '*',
      }}),
    }, PUBLIC_DNS)
    const response = await call('https://example.com/')
    expect(response.headers.get('x-proxy-final-url')).toBe('https://example.com/')
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(response.headers.get('x-proxy-header-x-proxy-final-url')).toBe('https://evil.example/')
  })

  it('exposes every proxy header to the browser', async () => {
    const {call} = setup({
      'https://example.com/': () => new Response(null, {status: 302, headers: {location: '/b'}}),
      'https://example.com/b': () => new Response('ok', {headers: {'x-rate-limit': '5'}}),
    }, PUBLIC_DNS)
    const response = await call('https://example.com/', {origin: 'https://stvad.github.io'})
    const exposed = response.headers.get('access-control-expose-headers')!.split(', ')
    expect(exposed).toEqual(expect.arrayContaining([
      'x-proxy-status', 'x-proxy-final-url', 'x-proxy-redirect-1', 'x-proxy-header-x-rate-limit',
    ]))
  })

  it('marks every response uncacheable', async () => {
    const {call} = setup({'https://example.com/': () => new Response('ok', {headers: {'cache-control': 'max-age=3600'}})}, PUBLIC_DNS)
    expect((await call('https://example.com/')).headers.get('cache-control')).toBe('no-store')
    expect((await call('http://127.0.0.1/')).headers.get('cache-control')).toBe('no-store')
  })

  it('refuses a body declared over the size cap', async () => {
    const limits = {...DEFAULT_LIMITS, maxBodyBytes: 4}
    const {call} = setup({'https://example.com/': () => new Response('too long', {headers: {'content-length': '8'}})}, PUBLIC_DNS, limits)
    expect(await errorOf(await call('https://example.com/'))).toEqual({status: 502, code: 'response-too-large'})
  })

  it('cuts off a body that grows past the size cap', async () => {
    const limits = {...DEFAULT_LIMITS, maxBodyBytes: 4}
    const {call} = setup({'https://example.com/': () => new Response('too long')}, PUBLIC_DNS, limits)
    const response = await call('https://example.com/')
    await expect(response.text()).rejects.toThrow('response-too-large')
  })

  it('reports a target that cannot be reached', async () => {
    const {call} = setup({}, PUBLIC_DNS)
    expect(await errorOf(await call('https://example.com/'))).toEqual({status: 502, code: 'upstream-failed'})
  })

  it('times out a target that does not answer', async () => {
    const limits = {...DEFAULT_LIMITS, timeoutMs: 20}
    const {call} = setup({
      'https://example.com/': req => new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(req.signal.reason))),
    }, PUBLIC_DNS, limits)
    expect(await errorOf(await call('https://example.com/'))).toEqual({status: 504, code: 'timeout'})
  })
})

describe('CORS', () => {
  const preflight = (origin: string, requestHeaders: string) => setup({}).handler(new Request(PROXY_ENDPOINT, {
    method: 'OPTIONS',
    headers: {origin, 'access-control-request-method': 'GET', 'access-control-request-headers': requestHeaders},
  }))

  it.each(['https://stvad.github.io', 'http://localhost:5173', 'http://127.0.0.1:4173'])('allows the app origin %s', async origin => {
    const response = await preflight(origin, 'authorization, apikey, x-proxy-url')
    expect(response.headers.get('access-control-allow-origin')).toBe(origin)
  })

  it.each(['https://evil.example', 'https://stvad.github.io.evil.example', 'http://localhost.evil.example'])('does not allow %s', async origin => {
    const response = await preflight(origin, 'authorization')
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('allows only the proxy\'s own request headers and target-addressed ones', async () => {
    const response = await preflight('https://stvad.github.io', 'Authorization, apikey, X-Proxy-Url, x-proxy-header-accept, x-other')
    expect(response.headers.get('access-control-allow-headers')).toBe('authorization, apikey, x-proxy-url, x-proxy-header-accept')
  })

  it('answers a preflight without authentication or fetching', async () => {
    const {handler, requests} = setup({})
    const response = await handler(new Request(PROXY_ENDPOINT, {method: 'OPTIONS', headers: {origin: 'https://stvad.github.io'}}))
    expect(response.status).toBe(204)
    expect(requests).toEqual([])
  })
})
