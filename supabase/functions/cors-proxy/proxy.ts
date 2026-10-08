/**
 * An authenticated CORS proxy: fetches an http(s) URL on behalf of a signed-in
 * user and relays the response to the browser, which can't read it cross-origin.
 *
 * Wire protocol (the client half is `src/services/proxyFetch.ts`):
 *   request   GET|HEAD with `X-Proxy-Url: <target>`; each `X-Proxy-Header-<name>`
 *             is sent to the target as `<name>`. Nothing else the caller sends
 *             reaches the target.
 *   response  200 with `X-Proxy-Status` (the target's status),
 *             `X-Proxy-Final-Url`, one `X-Proxy-Redirect-<n>: <status> <url>` per
 *             redirect followed, each target header as `X-Proxy-Header-<name>`,
 *             and the target's body.
 *   failure   non-200 with `X-Proxy-Error: <code>` and a JSON body. A response
 *             without `X-Proxy-Status` never came from a target.
 *
 * Target headers travel under a prefix in both directions so the browser applies
 * none of them to the proxy's origin (cookies, auth prompts, HSTS, reporting
 * endpoints) and a target can't forge the proxy's own `X-Proxy-*` headers.
 *
 * Pure module: no Deno globals, so vitest can run it. `index.ts` supplies the
 * platform (fetch, DNS, env).
 */

export const PROXY_URL_HEADER = 'x-proxy-url'
export const PROXY_HEADER_PREFIX = 'x-proxy-header-'
export const PROXY_STATUS_HEADER = 'x-proxy-status'
export const PROXY_FINAL_URL_HEADER = 'x-proxy-final-url'
export const PROXY_REDIRECT_HEADER_PREFIX = 'x-proxy-redirect-'
export const PROXY_ERROR_HEADER = 'x-proxy-error'

const ERROR_STATUS = {
  'method-not-allowed': 405,
  'unauthenticated': 401,
  'anonymous-session': 403,
  'auth-unavailable': 503,
  'invalid-url': 400,
  'forbidden-header': 400,
  'blocked-address': 403,
  'unresolvable': 502,
  'bad-redirect': 502,
  'too-many-redirects': 502,
  'response-too-large': 502,
  'timeout': 504,
  'upstream-failed': 502,
} as const

export type ProxyErrorCode = keyof typeof ERROR_STATUS

export interface ProxyLimits {
  maxRedirects: number
  maxBodyBytes: number
  timeoutMs: number
}

export const DEFAULT_LIMITS: ProxyLimits = {
  maxRedirects: 10,
  maxBodyBytes: 10 * 1024 * 1024,
  timeoutMs: 30_000,
}

export interface ProxyDeps {
  /** The project's own API URL; the caller's session is checked against its Auth. */
  supabaseUrl: string
  /** Must send a `Host` header it's given (Deno: a client created with `allowHost`). */
  fetch: typeof fetch
  /** Every A and AAAA record for `hostname`; empty when it doesn't resolve. */
  resolveDns: (hostname: string, signal: AbortSignal) => Promise<string[]>
  limits?: ProxyLimits
}

export interface Hop {
  status: number
  location: string
}

class Refusal extends Error {
  constructor(readonly code: ProxyErrorCode, detail?: string) {
    super(detail ?? code)
  }
}

// GET and HEAD only: no consumer sends a body yet, and accepting one means
// designing a request-size cap and content-type forwarding against a real need.
const ALLOWED_METHODS = new Set(['GET', 'HEAD'])

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** Request headers the proxy itself reads; the only unprefixed ones a preflight allows. */
const OWN_REQUEST_HEADERS = new Set(['authorization', 'apikey', 'x-client-info', PROXY_URL_HEADER])

/** Never sent to a target, even when asked for explicitly: connection framing,
 *  virtual-host override, and cookies (the proxy keeps no jar in either direction). */
const FORBIDDEN_TARGET_HEADERS = new Set([
  'host', 'cookie', 'cookie2', 'connection', 'keep-alive', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'content-length', 'expect',
])

/** Target response headers not relayed: framing that no longer describes the
 *  relayed body (fetch has already decoded it), and cookies. */
const UNRELAYED_RESPONSE_HEADERS = new Set([
  'set-cookie', 'set-cookie2', 'content-encoding', 'content-length',
  'transfer-encoding', 'connection', 'keep-alive', 'trailer', 'upgrade', 'proxy-connection',
])

const ALLOWED_ORIGIN = /^(?:https:\/\/stvad\.github\.io|http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?)$/

// --- addresses --------------------------------------------------------------

type Bytes = number[]

const parseIPv4 = (text: string): Bytes | null => {
  const parts = text.split('.')
  if (parts.length !== 4 || !parts.every(part => /^\d{1,3}$/.test(part))) return null
  const bytes = parts.map(Number)
  return bytes.every(byte => byte <= 255) ? bytes : null
}

const parseIPv6 = (text: string): Bytes | null => {
  let hex = text
  const lastGroup = hex.lastIndexOf(':') + 1
  if (hex.includes('.', lastGroup)) {
    const v4 = parseIPv4(hex.slice(lastGroup))
    if (!v4) return null
    hex = `${hex.slice(0, lastGroup)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`
  }
  const halves = hex.split('::')
  if (halves.length > 2) return null
  const groupsOf = (half: string) => (half === '' ? [] : half.split(':'))
  const head = groupsOf(halves[0])
  const tail = halves.length === 2 ? groupsOf(halves[1]) : []
  const elided = 8 - head.length - tail.length
  if (halves.length === 2 ? elided < 1 : elided !== 0) return null
  const groups = [...head, ...Array<string>(halves.length === 2 ? elided : 0).fill('0'), ...tail]
  if (!groups.every(group => /^[0-9a-f]{1,4}$/i.test(group))) return null
  return groups.flatMap(group => {
    const value = parseInt(group, 16)
    return [value >> 8, value & 0xff]
  })
}

interface Cidr {
  bytes: Bytes
  bits: number
}

const cidr = (text: string, parse: (address: string) => Bytes | null): Cidr => {
  const [address, bits] = text.split('/')
  return {bytes: parse(address)!, bits: Number(bits)}
}

const inCidr = (address: Bytes, {bytes, bits}: Cidr): boolean => {
  for (let bit = 0; bit < bits; bit++) {
    const mask = 0x80 >> (bit & 7)
    if ((address[bit >> 3] & mask) !== (bytes[bit >> 3] & mask)) return false
  }
  return true
}

// Every IPv4 special-purpose range that isn't globally reachable: private,
// loopback, link-local (cloud metadata at 169.254.169.254), carrier-grade NAT,
// documentation, benchmarking, multicast, reserved, broadcast.
const NON_PUBLIC_V4 = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16',
  '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
].map(range => cidr(range, parseIPv4))

const v6 = (range: string) => cidr(range, parseIPv6)

// IPv6 is allowlisted: only global unicast (2000::/3), minus its special-purpose
// carve-outs. Loopback, unspecified, unique-local, link-local, multicast and
// the deprecated IPv4-compatible block all fall outside 2000::/3.
const GLOBAL_UNICAST_V6 = v6('2000::/3')
const NON_PUBLIC_V6 = ['2001::/23', '2001:db8::/32', '3fff::/20'].map(v6)

// Ranges that carry an IPv4 address in their low bits, judged by that address.
const EMBEDDED_V4 = [
  {range: v6('::ffff:0:0/96'), offset: 12}, // IPv4-mapped
  {range: v6('64:ff9b::/96'), offset: 12}, // NAT64
  {range: v6('2002::/16'), offset: 2}, // 6to4
]

const isPublicV4 = (address: Bytes): boolean => !NON_PUBLIC_V4.some(range => inCidr(address, range))

/** Whether an IP address (dotted IPv4, or IPv6 without brackets) is a public
 *  internet address. Anything unparseable is not. */
export const isPublicAddress = (text: string): boolean => {
  const v4 = parseIPv4(text)
  if (v4) return isPublicV4(v4)
  const address = parseIPv6(text)
  if (!address) return false
  const embedding = EMBEDDED_V4.find(({range}) => inCidr(address, range))
  if (embedding) return isPublicV4(address.slice(embedding.offset, embedding.offset + 4))
  return inCidr(address, GLOBAL_UNICAST_V6) && !NON_PUBLIC_V6.some(range => inCidr(address, range))
}

// Names that resolve to a local network by convention. A dotless name resolves
// through the host's search domains. Checked before DNS because the resolver
// `fetch` uses may answer differently from `resolveDns` for exactly these
// (hosts file, search domains, mDNS).
const LOCAL_NAME = /(?:^|\.)(?:localhost|local|internal|home\.arpa)$/

/** Refused, or allowed with the checked address to connect to (null when the
 *  URL already names an address). */
type HostVerdict = {refused: ProxyErrorCode} | {address: string | null}

const vetHost = async (
  url: URL,
  resolveDns: ProxyDeps['resolveDns'],
  signal: AbortSignal,
): Promise<HostVerdict> => {
  const host = url.hostname.replace(/\.$/, '')
  const literal = (address: string): HostVerdict =>
    isPublicAddress(address) ? {address: null} : {refused: 'blocked-address'}
  // The URL parser normalizes every IPv4 spelling (hex, octal, a bare integer) to dotted decimal.
  if (host.startsWith('[')) return literal(host.slice(1, -1))
  if (parseIPv4(host)) return literal(host)
  if (!host.includes('.') || LOCAL_NAME.test(host)) return {refused: 'blocked-address'}
  const addresses = await resolveDns(host, signal)
  if (addresses.length === 0) return {refused: 'unresolvable'}
  // Every record, not just the one connected to: an https fetch resolves the name itself.
  if (!addresses.every(isPublicAddress)) return {refused: 'blocked-address'}
  return {address: addresses.find(address => parseIPv4(address)) ?? addresses[0]}
}

/** Where a hop connects. An http hop goes to the address `vetHost` checked,
 *  with the name in `Host`, so nothing resolves the name a second time — the
 *  window a DNS-rebinding attack needs. An https hop keeps its name: TLS binds
 *  the connection to it, and an internal host can't present a certificate for
 *  an attacker's domain. */
const connection = (url: URL, address: string | null, headers: Headers): {target: URL, headers: Headers} => {
  if (address === null || url.protocol !== 'http:') return {target: url, headers}
  const target = new URL(url)
  target.hostname = address.includes(':') ? `[${address}]` : address
  const pinned = new Headers(headers)
  pinned.set('host', url.host)
  return {target, headers: pinned}
}

// --- request ----------------------------------------------------------------

/** A URL the proxy will fetch: absolute http(s), no embedded credentials (fetch refuses them too). */
const fetchableUrl = (text: string, base?: URL): URL | null => {
  let url: URL
  try {
    url = new URL(text, base)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  return url
}

/** The headers the caller addressed to the target, unprefixed. */
const targetRequestHeaders = (incoming: Headers): Headers => {
  const outgoing = new Headers()
  for (const [name, value] of incoming) {
    if (!name.startsWith(PROXY_HEADER_PREFIX)) continue
    const targetName = name.slice(PROXY_HEADER_PREFIX.length)
    if (!targetName || FORBIDDEN_TARGET_HEADERS.has(targetName) || targetName.startsWith('proxy-')) {
      throw new Refusal('forbidden-header', `${targetName || '(empty)'} is never sent to a target`)
    }
    outgoing.append(targetName, value)
  }
  return outgoing
}

type Caller = 'user' | 'unauthenticated' | 'anonymous-session' | 'auth-unavailable'

const AUTH_TIMEOUT_MS = 10_000

/** Checks the caller's session against the project's Auth. The platform's
 *  `verify_jwt` gate can't do this: it also admits the publishable key, which
 *  ships in the app bundle, and anonymous sign-in mints a session for anyone. */
const authenticate = async (req: Request, deps: ProxyDeps): Promise<Caller> => {
  const authorization = req.headers.get('authorization')
  const apikey = req.headers.get('apikey')
  if (!authorization?.startsWith('Bearer ') || !apikey) return 'unauthenticated'
  let response: Response
  try {
    response = await deps.fetch(new URL('auth/v1/user', `${deps.supabaseUrl.replace(/\/+$/, '')}/`), {
      headers: {authorization, apikey},
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    })
  } catch {
    return 'auth-unavailable'
  }
  if (!response.ok) {
    await response.body?.cancel()
    return response.status >= 500 ? 'auth-unavailable' : 'unauthenticated'
  }
  const user = await response.json().catch(() => null)
  if (typeof user?.id !== 'string') return 'unauthenticated'
  return user.is_anonymous === false ? 'user' : 'anonymous-session'
}

// --- fetching ---------------------------------------------------------------

/** Follows redirects one hop at a time so every hop's host passes `vetHost`
 *  before anything connects to it. Records each hop in `hops`. */
const follow = async (
  start: URL,
  method: string,
  headers: Headers,
  hops: Hop[],
  deps: ProxyDeps,
  limits: ProxyLimits,
  signal: AbortSignal,
): Promise<{response: Response, url: URL}> => {
  let url = start
  for (;;) {
    const verdict = await vetHost(url, deps.resolveDns, signal)
    if ('refused' in verdict) throw new Refusal(verdict.refused, url.hostname)
    const hop = connection(url, verdict.address, headers)
    let response: Response
    try {
      response = await deps.fetch(hop.target, {method, headers: hop.headers, redirect: 'manual', signal})
    } catch {
      throw new Refusal('upstream-failed', url.hostname)
    }
    const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get('location') : null
    if (location === null) return {response, url}
    await response.body?.cancel()
    const next = fetchableUrl(location, url)
    if (!next) throw new Refusal('bad-redirect', `hop ${hops.length + 1} is not an http(s) URL`)
    hops.push({status: response.status, location: next.href})
    if (hops.length > limits.maxRedirects) throw new Refusal('too-many-redirects')
    // As fetch does: credentials the caller meant for one origin don't follow a redirect to another.
    if (next.origin !== url.origin) headers.delete('authorization')
    url = next
  }
}

/** `body`, erroring once more than `maxBytes` have passed. The status is already
 *  sent by then, so the client sees a failed body read. */
const capped = (body: ReadableStream<Uint8Array>, maxBytes: number): ReadableStream<Uint8Array> => {
  let seen = 0
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength
      if (seen > maxBytes) controller.error(new Error('response-too-large'))
      else controller.enqueue(chunk)
    },
  }))
}

// --- responses --------------------------------------------------------------

const corsHeaders = (origin: string | null): Headers => {
  const headers = new Headers({vary: 'Origin'})
  if (origin && ALLOWED_ORIGIN.test(origin)) headers.set('access-control-allow-origin', origin)
  return headers
}

/** Headers every proxy response carries: CORS, no caching (every target shares
 *  the proxy's URL, so a cached response could answer for another target), and
 *  the redirect hops. */
const baseHeaders = (cors: Headers, hops: Hop[]): Headers => {
  const headers = new Headers(cors)
  headers.set('cache-control', 'no-store')
  hops.forEach(({status, location}, index) => {
    headers.set(`${PROXY_REDIRECT_HEADER_PREFIX}${index + 1}`, `${status} ${location}`)
  })
  return headers
}

const exposeProxyHeaders = (headers: Headers): Headers => {
  const names = [...headers.keys()].filter(name => name.startsWith('x-proxy-'))
  if (names.length) headers.set('access-control-expose-headers', names.join(', '))
  return headers
}

const failure = (cors: Headers, refusal: Refusal, hops: Hop[]): Response => {
  const headers = baseHeaders(cors, hops)
  headers.set('content-type', 'application/json')
  headers.set(PROXY_ERROR_HEADER, refusal.code)
  return new Response(
    JSON.stringify({error: refusal.code, message: refusal.message}),
    {status: ERROR_STATUS[refusal.code], headers: exposeProxyHeaders(headers)},
  )
}

const relay = async (
  cors: Headers,
  method: string,
  {response, url}: {response: Response, url: URL},
  hops: Hop[],
  maxBodyBytes: number,
): Promise<Response> => {
  if (Number(response.headers.get('content-length') ?? 0) > maxBodyBytes) {
    await response.body?.cancel()
    throw new Refusal('response-too-large', `over ${maxBodyBytes} bytes`)
  }
  const headers = baseHeaders(cors, hops)
  headers.set(PROXY_STATUS_HEADER, String(response.status))
  headers.set(PROXY_FINAL_URL_HEADER, url.href)
  for (const [name, value] of response.headers) {
    if (!UNRELAYED_RESPONSE_HEADERS.has(name)) headers.append(`${PROXY_HEADER_PREFIX}${name}`, value)
  }
  // fetch already gives a null-body status (204, 304) a null body.
  const bodiless = method === 'HEAD' || !response.body
  if (bodiless) await response.body?.cancel()
  const body = bodiless ? null : capped(response.body!, maxBodyBytes)
  return new Response(body, {status: 200, headers: exposeProxyHeaders(headers)})
}

const preflight = (req: Request, cors: Headers): Response => {
  const headers = new Headers(cors)
  const requested = (req.headers.get('access-control-request-headers') ?? '')
    .split(',')
    .map(name => name.trim().toLowerCase())
    .filter(name => OWN_REQUEST_HEADERS.has(name) || name.length > PROXY_HEADER_PREFIX.length && name.startsWith(PROXY_HEADER_PREFIX))
  headers.set('access-control-allow-methods', [...ALLOWED_METHODS].join(', '))
  if (requested.length) headers.set('access-control-allow-headers', requested.join(', '))
  headers.set('access-control-max-age', '7200')
  return new Response(null, {status: 204, headers})
}

const isTimeout = (signal: AbortSignal): boolean =>
  signal.aborted && (signal.reason as {name?: string} | undefined)?.name === 'TimeoutError'

export const createProxyHandler = (deps: ProxyDeps) => async (req: Request): Promise<Response> => {
  const limits = deps.limits ?? DEFAULT_LIMITS
  const cors = corsHeaders(req.headers.get('origin'))
  if (req.method === 'OPTIONS') return preflight(req, cors)

  const hops: Hop[] = []
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(limits.timeoutMs)])
  try {
    if (!ALLOWED_METHODS.has(req.method)) throw new Refusal('method-not-allowed', 'GET or HEAD')
    // Before anything else, so a stranger learns nothing about what the proxy would fetch.
    const caller = await authenticate(req, deps)
    if (caller !== 'user') throw new Refusal(caller)
    const target = fetchableUrl(req.headers.get(PROXY_URL_HEADER) ?? '')
    if (!target) throw new Refusal('invalid-url', `${PROXY_URL_HEADER} must be an absolute http(s) URL`)
    const headers = targetRequestHeaders(req.headers)
    const outcome = await follow(target, req.method, headers, hops, deps, limits, signal)
    return await relay(cors, req.method, outcome, hops, limits.maxBodyBytes)
  } catch (error) {
    if (isTimeout(signal)) return failure(cors, new Refusal('timeout'), hops)
    if (error instanceof Refusal) return failure(cors, error, hops)
    throw error
  }
}
