/** `fetch` for URLs a browser can't read cross-origin, through the `cors-proxy`
 *  edge function. The server half and the wire protocol are in
 *  `supabase/functions/cors-proxy/proxy.ts`. */

import { isRemoteSyncActive } from '@/data/repoProvider'
import { edgeFunctionEndpoint, supabase } from '@/services/supabase'

const CORS_PROXY_FUNCTION = 'cors-proxy'
const TARGET_HEADER_PREFIX = 'x-proxy-header-'
const NULL_BODY_STATUSES = new Set([204, 205, 304])

export interface ProxyRedirect {
  status: number
  /** The absolute URL the redirect pointed to. */
  location: string
}

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

/** `code` is the proxy's own refusal (`ProxyErrorCode` in the server half), or:
 *  `local-only` / `signed-out` / `anonymous-session`, refused here before
 *  anything is sent; `unreachable`, no answer from the proxy (network, not deployed). */
export class ProxyFetchError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ProxyFetchError'
  }
}

/** Resolves like `fetch`: a target's 4xx/5xx is a response. Rejects with
 *  `ProxyFetchError` when the proxy can't serve the request, and with the
 *  caller's abort reason when `init.signal` aborts. */
export const proxyFetch = async (url: string | URL, init: ProxyFetchInit = {}): Promise<ProxyFetchResult> => {
  // `supabase` being non-null only means auth is CONFIGURED; a local-only session sends nothing.
  if (!isRemoteSyncActive()) throw new ProxyFetchError('local-only', 'Fetching other sites needs sync, and this session is local-only.')
  const endpoint = edgeFunctionEndpoint(CORS_PROXY_FUNCTION)
  const session = supabase && endpoint ? (await supabase.auth.getSession()).data.session : null
  if (!endpoint || !session) throw new ProxyFetchError('signed-out', 'Fetching other sites needs a signed-in account.')
  // The proxy refuses these too; checking here saves the round trip.
  if (session.user.is_anonymous) throw new ProxyFetchError('anonymous-session', 'Fetching other sites needs an account signed in with email.')

  const headers = new Headers({
    authorization: `Bearer ${session.access_token}`,
    apikey: endpoint.apiKey,
    'x-proxy-url': String(url),
  })
  new Headers(init.headers).forEach((value, name) => headers.append(`${TARGET_HEADER_PREFIX}${name}`, value))

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
  const status = wire.headers.get('x-proxy-status')
  if (status === null) {
    // Without X-Proxy-Status the answer isn't a target's: a refusal, or not the proxy at all.
    const code = wire.headers.get('x-proxy-error')
    const body = await wire.json().catch(() => null) as {message?: unknown} | null
    throw code
      ? new ProxyFetchError(code, `The proxy refused: ${typeof body?.message === 'string' ? body.message : code}`)
      : new ProxyFetchError('unreachable', `The proxy is unavailable (HTTP ${wire.status}).`)
  }

  const headers = new Headers()
  wire.headers.forEach((value, name) => {
    if (name.startsWith(TARGET_HEADER_PREFIX)) headers.append(name.slice(TARGET_HEADER_PREFIX.length), value)
  })

  const redirects: ProxyRedirect[] = []
  for (let hop = 1; ; hop++) {
    const value = wire.headers.get(`x-proxy-redirect-${hop}`)
    if (value === null) break
    const space = value.indexOf(' ')
    redirects.push({status: Number(value.slice(0, space)), location: value.slice(space + 1)})
  }

  const targetStatus = Number(status)
  // The wire response is a 200, so its body is a stream even when the target's
  // status forbids one, and `Response` throws on that pairing.
  const nullBody = NULL_BODY_STATUSES.has(targetStatus)
  if (nullBody) await wire.body?.cancel()
  return {
    response: new Response(nullBody ? null : wire.body, {status: targetStatus, headers}),
    url: wire.headers.get('x-proxy-final-url') ?? '',
    redirects,
  }
}
