/** A fake internet for the proxy's tests: exact-URL routes, the project's Auth,
 *  and a DNS table. Behaves like the real network where the proxy depends on
 *  it: routes by the Host header when one is sent (virtual hosts), and follows
 *  redirects itself unless told `manual`. */

export const SUPABASE_URL = 'https://project.test'
export const AUTH_URL = `${SUPABASE_URL}/auth/v1/user`
export const PUBLIC_IP = '93.184.215.14'

export type Route = (req: Request) => Response | Promise<Response>

const authRoute: Route = req => {
  switch (req.headers.get('authorization')) {
    case 'Bearer user-token': return Response.json({id: 'user-1', is_anonymous: false})
    case 'Bearer anonymous-token': return Response.json({id: 'user-2', is_anonymous: true})
    default: return Response.json({msg: 'invalid JWT'}, {status: 401})
  }
}

/** Requests are recorded in `requests`; `routes[AUTH_URL]` overrides the Auth stub. */
export const fakeNetwork = (routes: Record<string, Route>, dns: Record<string, string[]> = {}) => {
  const requests: Request[] = []
  const lookups: string[] = []
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init)
    requests.push(req)
    const addressed = new URL(req.url)
    const host = req.headers.get('host')
    if (host) addressed.host = host
    const route = addressed.href === AUTH_URL ? (routes[AUTH_URL] ?? authRoute) : routes[addressed.href]
    if (!route) throw new TypeError(`connection refused: ${addressed.href}`)
    const response = await route(req)
    const location = response.headers.get('location')
    if (req.redirect !== 'manual' && location && response.status >= 300 && response.status < 400) {
      return fetch(new URL(location, req.url), init)
    }
    return response
  }
  const resolveDns = async (hostname: string) => {
    lookups.push(hostname)
    return dns[hostname] ?? []
  }
  const targetRequests = () => requests.filter(req => req.url !== AUTH_URL)
  return {fetch, resolveDns, requests, lookups, targetRequests}
}
