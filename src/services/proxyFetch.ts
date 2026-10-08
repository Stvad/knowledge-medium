/** `fetch` for URLs a browser can't read cross-origin, through the `cors-proxy`
 *  edge function. The wire protocol is in `supabase/functions/cors-proxy/protocol.ts`. */

import { isRemoteSyncActive } from '@/data/repoProvider'
import { edgeFunctionEndpoint, supabase } from '@/services/supabase'
import {
  isProxyErrorCode,
  PROXY_ERROR_HEADER,
  PROXY_FINAL_URL_HEADER,
  PROXY_HEADER_PREFIX,
  PROXY_STATUS_HEADER,
  PROXY_URL_HEADER,
  type ProxyErrorCode,
  type ProxyRedirect,
  readRedirects,
} from '../../supabase/functions/cors-proxy/protocol.ts'

export type { ProxyRedirect }

const CORS_PROXY_FUNCTION = 'cors-proxy'
const NULL_BODY_STATUSES = new Set([204, 205, 304])

export interface ProxyFetchResult {
  /** The target's status, headers and body. */
  response: Response
  /** The URL the response came from, after redirects. */
  url: string
  /** Every redirect the proxy followed, in order. A browser `fetch` hides these. */
  redirects: ProxyRedirect[]
}

export interface ProxyFetchInit {
  method?: 'GET' | 'HEAD'
  /** Sent to the target, and nothing else is. The proxy refuses Cookie, Host
   *  and connection headers, and drops Authorization on a cross-origin redirect. */
  headers?: HeadersInit
  signal?: AbortSignal
}

/** Refused here before anything is sent (`local-only`, `signed-out`,
 *  `anonymous-session`, `invalid-url`); no answer from the proxy (`unreachable`:
 *  network, session refresh, not deployed); or the proxy's own refusal. */
export type ProxyFetchErrorCode = ProxyErrorCode | 'local-only' | 'signed-out' | 'unreachable'

export class ProxyFetchError extends Error {
  constructor(
    readonly code: ProxyFetchErrorCode,
    message: string,
    /** The redirects followed before the refusal. */
    readonly redirects: ProxyRedirect[] = [],
  ) {
    super(message)
    this.name = 'ProxyFetchError'
  }
}

/** Resolves like `fetch`: a target's 4xx/5xx is a response. Rejects with
 *  `ProxyFetchError` when the proxy can't serve the request, and with the
 *  caller's abort reason when `init.signal` aborts. */
export const proxyFetch = async (url: string | URL, init: ProxyFetchInit = {}): Promise<ProxyFetchResult> => {
  let target: string
  try {
    // Serialized: a header value must be ASCII, and `href` percent-encodes the rest.
    target = new URL(url).href
  } catch {
    throw new ProxyFetchError('invalid-url', `Not an absolute URL: ${url}`)
  }
  // `supabase` being non-null only means auth is CONFIGURED; a local-only session sends nothing.
  if (!isRemoteSyncActive()) throw new ProxyFetchError('local-only', 'Fetching other sites needs sync, and this session is local-only.')
  const endpoint = edgeFunctionEndpoint(CORS_PROXY_FUNCTION)
  if (!supabase || !endpoint) throw new ProxyFetchError('signed-out', 'Fetching other sites needs a signed-in account.')
  // A session near expiry is refreshed here, which needs the network.
  const {data: {session}, error} = await supabase.auth.getSession()
    .catch((reason: unknown) => ({data: {session: null}, error: reason}))
  if (error) throw new ProxyFetchError('unreachable', `Couldn't refresh the session: ${error}`)
  if (!session) throw new ProxyFetchError('signed-out', 'Fetching other sites needs a signed-in account.')
  // The proxy refuses these too; checking here saves the round trip.
  if (session.user.is_anonymous) throw new ProxyFetchError('anonymous-session', 'Fetching other sites needs an account signed in with email.')

  const headers = new Headers({
    authorization: `Bearer ${session.access_token}`,
    apikey: endpoint.apiKey,
    [PROXY_URL_HEADER]: target,
  })
  new Headers(init.headers).forEach((value, name) => headers.append(`${PROXY_HEADER_PREFIX}${name}`, value))

  let wire: Response
  try {
    wire = await fetch(endpoint.url, {method: init.method ?? 'GET', headers, signal: init.signal})
  } catch (error) {
    if (init.signal?.aborted) throw error
    throw new ProxyFetchError('unreachable', `The proxy didn't answer: ${error}`)
  }
  return readProxyResponse(wire)
}

const readProxyResponse = async (wire: Response): Promise<ProxyFetchResult> => {
  const redirects = readRedirects(wire.headers)
  const status = wire.headers.get(PROXY_STATUS_HEADER)
  if (status === null) {
    // Without X-Proxy-Status the answer isn't a target's: a refusal, or not the proxy at all.
    const code = wire.headers.get(PROXY_ERROR_HEADER)
    const body = await wire.json().catch(() => null) as {message?: unknown} | null
    throw code !== null && isProxyErrorCode(code)
      ? new ProxyFetchError(code, `The proxy refused: ${typeof body?.message === 'string' ? body.message : code}`, redirects)
      : new ProxyFetchError('unreachable', `The proxy is unavailable (HTTP ${wire.status}).`)
  }

  const headers = new Headers()
  wire.headers.forEach((value, name) => {
    if (name.startsWith(PROXY_HEADER_PREFIX)) headers.append(name.slice(PROXY_HEADER_PREFIX.length), value)
  })
  const targetStatus = Number(status)
  // The wire response is a 200, so its body is a stream even when the target's
  // status forbids one, and `Response` throws on that pairing.
  const nullBody = NULL_BODY_STATUSES.has(targetStatus)
  if (nullBody) await wire.body?.cancel()
  return {
    response: new Response(nullBody ? null : wire.body, {status: targetStatus, headers}),
    url: wire.headers.get(PROXY_FINAL_URL_HEADER) ?? '',
    redirects,
  }
}
