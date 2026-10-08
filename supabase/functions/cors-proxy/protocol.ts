/**
 * The cors-proxy wire protocol, shared by the edge function (`proxy.ts`) and
 * the browser client (`src/services/proxyFetch.ts`).
 *
 *   request   GET|HEAD with `X-Proxy-Url: <target>` (see `fetchableUrl`); each
 *             `X-Proxy-Header-<name>` is sent to the target as `<name>`, except
 *             ones the proxy owns (Host, Cookie, Accept-Encoding, Proxy-*,
 *             connection framing), which are refused. Nothing else the caller
 *             sends reaches the target; the proxy asks it for an unencoded body.
 *   response  200 with `X-Proxy-Status` (the target's status),
 *             `X-Proxy-Final-Url`, one `X-Proxy-Redirect-<n>: <status> <url>` per
 *             redirect followed, the target's headers as `X-Proxy-Header-<name>`
 *             (without cookies, hop-by-hop headers, and, when a body is
 *             relayed, Content-Length and Content-Encoding), and the target's
 *             body, decoded.
 *   failure   non-200 with `X-Proxy-Error: <code>`, the redirects followed so
 *             far, and a JSON `{error, message}`. A response without
 *             `X-Proxy-Status` never came from a target.
 *
 * Target headers travel under a prefix in both directions so the browser applies
 * none of them to the proxy's origin (cookies, auth prompts, HSTS, reporting
 * endpoints) and a target can't forge the proxy's own `X-Proxy-*` headers.
 *
 * Dependency-free: Deno and the app's bundler both import it.
 */

export const PROXY_URL_HEADER = 'x-proxy-url'
export const PROXY_HEADER_PREFIX = 'x-proxy-header-'
export const PROXY_STATUS_HEADER = 'x-proxy-status'
export const PROXY_FINAL_URL_HEADER = 'x-proxy-final-url'
export const PROXY_ERROR_HEADER = 'x-proxy-error'
const PROXY_REDIRECT_HEADER_PREFIX = 'x-proxy-redirect-'

/** Every refusal the proxy sends, with its HTTP status. */
export const ERROR_STATUS = {
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
  'busy': 503,
} as const

export type ProxyErrorCode = keyof typeof ERROR_STATUS

export const isProxyErrorCode = (code: string): code is ProxyErrorCode => Object.hasOwn(ERROR_STATUS, code)

export interface ProxyRedirect {
  status: number
  /** The absolute URL the redirect pointed to. */
  location: string
}

export const writeRedirects = (headers: Headers, redirects: readonly ProxyRedirect[]): void => {
  redirects.forEach(({status, location}, index) => {
    headers.set(`${PROXY_REDIRECT_HEADER_PREFIX}${index + 1}`, `${status} ${location}`)
  })
}

export const readRedirects = (headers: Headers): ProxyRedirect[] => {
  const redirects: ProxyRedirect[] = []
  for (let hop = 1; ; hop++) {
    const value = headers.get(`${PROXY_REDIRECT_HEADER_PREFIX}${hop}`)
    if (value === null) return redirects
    const space = value.indexOf(' ')
    redirects.push({status: Number(value.slice(0, space)), location: value.slice(space + 1)})
  }
}

/** A URL the proxy will fetch: absolute http(s), no embedded credentials (fetch refuses them too). */
export const fetchableUrl = (text: string, base?: URL): URL | null => {
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
