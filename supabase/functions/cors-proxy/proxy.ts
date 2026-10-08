/**
 * An authenticated CORS proxy: fetches an http(s) URL on behalf of a signed-in
 * user and relays the response to the browser, which can't read it
 * cross-origin. The wire protocol is in `./protocol.ts`.
 *
 * Pure module: no Deno globals, so vitest can run it. `index.ts` supplies the
 * platform (fetch, DNS, env).
 */

import {
  ERROR_STATUS,
  fetchableUrl,
  PROXY_ERROR_HEADER,
  PROXY_FINAL_URL_HEADER,
  PROXY_HEADER_PREFIX,
  PROXY_STATUS_HEADER,
  PROXY_URL_HEADER,
  type ProxyErrorCode,
  type ProxyRedirect,
  writeRedirects,
} from './protocol.ts'

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
  /** Comma-separated origins whose pages may read responses, besides local dev
   *  servers (`CORS_PROXY_ALLOWED_ORIGINS`). Unset means the app's own deployment. */
  allowedOrigins?: string
  limits?: ProxyLimits
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
const OWN_REQUEST_HEADERS = new Set(['authorization', 'apikey', PROXY_URL_HEADER])

/** Never sent to a target, even when asked for explicitly: connection framing,
 *  virtual-host override, cookies (the proxy keeps no jar in either direction),
 *  and content negotiation (fetch asks only for the codings it decodes). */
const FORBIDDEN_TARGET_HEADERS = new Set([
  'host', 'cookie', 'cookie2', 'connection', 'keep-alive', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'content-length', 'expect', 'accept-encoding',
])

/** Target response headers never relayed: cookies, and hop-by-hop headers of
 *  the proxy's own connection to the target. */
const UNRELAYED_RESPONSE_HEADERS = new Set([
  'set-cookie', 'set-cookie2',
  'transfer-encoding', 'connection', 'keep-alive', 'trailer', 'upgrade', 'proxy-connection',
])

/** Describe the bytes fetch received, which it has already decoded; relayed
 *  only when no body is (HEAD, 204, 304), where they still describe the target's resource. */
const ENCODED_BODY_HEADERS = new Set(['content-encoding', 'content-length'])

/** The content codings fetch asks for and decodes. It asks for identity alone
 *  when the request carries Range. */
const FETCH_DECODED_CODINGS = new Set(['gzip', 'br'])

/** Whether fetch decoded a body sent with `coding`. One it didn't would reach
 *  the client still encoded, but labelled as decoded. */
const decodedByFetch = (coding: string | null, ranged: boolean): boolean => {
  const token = coding?.trim().toLowerCase() || 'identity'
  return token === 'identity' || (!ranged && FETCH_DECODED_CODINGS.has(token))
}

const DEPLOYED_APP_ORIGIN = 'https://stvad.github.io'
const LOCAL_DEV_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/

const appOrigins = (configured: string | undefined): Set<string> => {
  const origins = new Set<string>()
  for (const entry of (configured?.trim() || DEPLOYED_APP_ORIGIN).split(',')) {
    try {
      const {origin} = new URL(entry.trim())
      // An opaque origin (file:, data:) serializes as "null", which every sandboxed page sends.
      if (origin !== 'null') origins.add(origin)
    } catch {
      // Not a URL; it names no origin.
    }
  }
  return origins
}

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

/** A name that resolves to a local network by convention, or (dotless) through
 *  the host's search domains. Refused before DNS because the resolver `fetch`
 *  uses (getaddrinfo: hosts file, search domains, mDNS) may answer differently
 *  from `resolveDns` for exactly these. */
const isLocalName = (host: string): boolean =>
  !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|home\.arpa)$/.test(host)

/** Refuses `url`'s host unless it is public, and returns the checked address to
 *  connect to (null when the URL already names an address). */
const vetHost = async (url: URL, resolveDns: ProxyDeps['resolveDns'], signal: AbortSignal): Promise<string | null> => {
  const refuse = (code: ProxyErrorCode) => new Refusal(code, url.hostname)
  const host = url.hostname.replace(/\.+$/, '')
  // The URL parser normalizes every IPv4 spelling (hex, octal, a bare integer) to dotted decimal.
  const literal = host.startsWith('[') ? host.slice(1, -1) : parseIPv4(host) ? host : null
  if (literal !== null) {
    if (!isPublicAddress(literal)) throw refuse('blocked-address')
    return null
  }
  if (isLocalName(host)) throw refuse('blocked-address')
  const addresses = await resolveDns(host, signal)
  if (addresses.length === 0) throw refuse('unresolvable')
  // Every record, not just the one connected to: an https fetch resolves the name itself.
  if (!addresses.every(isPublicAddress)) throw refuse('blocked-address')
  return addresses.find(address => parseIPv4(address)) ?? addresses[0]
}

/** Where a hop connects. An http hop goes to the address `vetHost` checked,
 *  with the name in `Host`, so nothing resolves the name a second time — the
 *  window a DNS-rebinding attack needs. An https hop keeps its name: TLS binds
 *  the connection to it, and an internal host can't present a certificate for
 *  an attacker's domain. Accepted: a rebound https hop still opens a TCP
 *  connection to the internal address before TLS fails, so its timing can tell
 *  an open internal port from a closed one. */
const connection = (url: URL, address: string | null, headers: Headers): {target: URL, headers: Headers} => {
  if (address === null || url.protocol !== 'http:') return {target: url, headers}
  const target = new URL(url)
  target.hostname = address.includes(':') ? `[${address}]` : address
  const pinned = new Headers(headers)
  pinned.set('host', url.host)
  return {target, headers: pinned}
}

// --- request ----------------------------------------------------------------

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

const AUTH_TIMEOUT_MS = 10_000

/** Refuses the caller unless its session belongs to a non-anonymous user of the
 *  project's Auth. The platform's `verify_jwt` gate can't do this: it also
 *  admits the publishable key, which ships in the app bundle, and anonymous
 *  sign-in mints a session for anyone. */
const authenticate = async (req: Request, deps: ProxyDeps): Promise<void> => {
  const authorization = req.headers.get('authorization')
  const apikey = req.headers.get('apikey')
  if (!authorization?.startsWith('Bearer ') || !apikey) throw new Refusal('unauthenticated')
  const unavailable = (): never => {
    throw new Refusal('auth-unavailable')
  }
  const response = await deps.fetch(new URL('auth/v1/user', `${deps.supabaseUrl.replace(/\/+$/, '')}/`), {
    headers: {authorization, apikey},
    // Auth answers itself; a redirect would carry the caller's token elsewhere.
    redirect: 'error',
    signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
  }).catch(unavailable)
  if (!response.ok) {
    await response.body?.cancel()
    throw new Refusal(response.status >= 500 ? 'auth-unavailable' : 'unauthenticated')
  }
  const user = await response.json().catch(unavailable) as {id?: unknown, is_anonymous?: unknown} | null
  if (typeof user?.id !== 'string') throw new Refusal('unauthenticated')
  if (user.is_anonymous !== false) throw new Refusal('anonymous-session')
}

// --- fetching ---------------------------------------------------------------

/** Follows redirects one hop at a time so every hop's host passes `vetHost`
 *  before anything connects to it. Records each hop in `hops`. */
const follow = async (
  start: URL,
  method: string,
  headers: Headers,
  hops: ProxyRedirect[],
  deps: ProxyDeps,
  limits: ProxyLimits,
  signal: AbortSignal,
): Promise<{response: Response, url: URL}> => {
  let url = start
  for (;;) {
    const hop = connection(url, await vetHost(url, deps.resolveDns, signal), headers)
    const response = await deps.fetch(hop.target, {method, headers: hop.headers, redirect: 'manual', signal})
      .catch((): never => {
        throw new Refusal('upstream-failed', url.hostname)
      })
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

/** The whole target body, refused past `maxBytes`. Read in full before anything
 *  is sent: a body that fails or overflows mid-stream would otherwise reach the
 *  client as a 200 cut short, which a gateway may pass on as complete. Each
 *  chunk is copied out as it arrives: fetch's chunks are views of 64 KiB
 *  buffers, so keeping them would hold 64 KiB per chunk however few bytes
 *  arrived, and a slow drip would multiply the memory a body costs. */
const readBody = async (response: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> => {
  const tooLarge = () => new Refusal('response-too-large', `over ${maxBytes} bytes`)
  const reader = response.body!.getReader()
  // Refused up front when declared, so an oversized body isn't downloaded first.
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
    await reader.cancel()
    throw tooLarge()
  }
  let body = new Uint8Array(Math.min(maxBytes, 64 * 1024))
  let size = 0
  try {
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      const end = size + read.value.byteLength
      if (end > maxBytes) {
        await reader.cancel()
        throw tooLarge()
      }
      if (end > body.length) {
        const grown = new Uint8Array(Math.min(maxBytes, Math.max(end, body.length * 2)))
        grown.set(body.subarray(0, size))
        body = grown
      }
      body.set(read.value, size)
      size = end
    }
  } catch (error) {
    throw error instanceof Refusal ? error : new Refusal('upstream-failed', 'the body failed mid-read')
  }
  return body.subarray(0, size)
}

// --- responses --------------------------------------------------------------

const corsHeaders = (origin: string | null, allowed: Set<string>): Headers => {
  const headers = new Headers({vary: 'Origin'})
  if (origin && (allowed.has(origin) || LOCAL_DEV_ORIGIN.test(origin))) headers.set('access-control-allow-origin', origin)
  return headers
}

/** Headers every proxy response carries: CORS, no caching (every target shares
 *  the proxy's URL, so a cached response could answer for another target), and
 *  the redirect hops. */
const baseHeaders = (cors: Headers, hops: ProxyRedirect[]): Headers => {
  const headers = new Headers(cors)
  headers.set('cache-control', 'no-store')
  writeRedirects(headers, hops)
  return headers
}

const exposeProxyHeaders = (headers: Headers): Headers => {
  const names = [...headers.keys()].filter(name => name.startsWith('x-proxy-'))
  if (names.length) headers.set('access-control-expose-headers', names.join(', '))
  return headers
}

const failure = (cors: Headers, refusal: Refusal, hops: ProxyRedirect[]): Response => {
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
  {response, url}: {response: Response, url: URL},
  hops: ProxyRedirect[],
  maxBodyBytes: number,
  ranged: boolean,
): Promise<Response> => {
  // Every Response constructor, the client's included, throws outside 200–599.
  if (response.status < 200 || response.status > 599) {
    await response.body?.cancel()
    throw new Refusal('upstream-failed', `the target answered with status ${response.status}`)
  }
  // fetch gives a HEAD response, and a null-body status (204, 205, 304), a null body.
  let body: Uint8Array<ArrayBuffer> | null = null
  if (response.body) {
    const coding = response.headers.get('content-encoding')
    if (!decodedByFetch(coding, ranged)) {
      await response.body.cancel()
      throw new Refusal('upstream-failed', `the body is ${coding}-encoded, which the proxy doesn't decode`)
    }
    body = await readBody(response, maxBodyBytes)
  }
  const headers = baseHeaders(cors, hops)
  headers.set(PROXY_STATUS_HEADER, String(response.status))
  headers.set(PROXY_FINAL_URL_HEADER, url.href)
  for (const [name, value] of response.headers) {
    if (UNRELAYED_RESPONSE_HEADERS.has(name) || (body && ENCODED_BODY_HEADERS.has(name))) continue
    headers.append(`${PROXY_HEADER_PREFIX}${name}`, value)
  }
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

export const createProxyHandler = (deps: ProxyDeps) => {
  const allowedOrigins = appOrigins(deps.allowedOrigins)
  return (req: Request): Promise<Response> => handle(req, deps, allowedOrigins)
}

const handle = async (req: Request, deps: ProxyDeps, allowedOrigins: Set<string>): Promise<Response> => {
  const limits = deps.limits ?? DEFAULT_LIMITS
  const cors = corsHeaders(req.headers.get('origin'), allowedOrigins)
  if (req.method === 'OPTIONS') return preflight(req, cors)

  const hops: ProxyRedirect[] = []
  // Ends the upstream work when the caller goes away, too. All of it is done
  // before a response is returned, so Deno.serve aborting `req.signal` once a
  // response completes cuts nothing short.
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(limits.timeoutMs)])
  try {
    if (!ALLOWED_METHODS.has(req.method)) throw new Refusal('method-not-allowed', 'GET or HEAD')
    // Before reading the target or its headers, so a stranger learns nothing about what the proxy would fetch.
    await authenticate(req, deps)
    const target = fetchableUrl(req.headers.get(PROXY_URL_HEADER) ?? '')
    if (!target) throw new Refusal('invalid-url', `${PROXY_URL_HEADER} must be an absolute http(s) URL`)
    const headers = targetRequestHeaders(req.headers)
    const ranged = headers.has('range')
    const outcome = await follow(target, req.method, headers, hops, deps, limits, signal)
    return await relay(cors, outcome, hops, limits.maxBodyBytes, ranged)
  } catch (error) {
    if (isTimeout(signal)) return failure(cors, new Refusal('timeout'), hops)
    if (error instanceof Refusal) return failure(cors, error, hops)
    throw error
  }
}
