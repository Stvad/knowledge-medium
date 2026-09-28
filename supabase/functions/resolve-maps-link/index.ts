// Expands a Google Maps short link (maps.app.goo.gl/…, goo.gl/maps/…) to
// the google.com/maps URL it redirects to. The geo plugin calls this
// because a browser can't: the redirect carries no CORS headers.
//
// Fetches ONLY short-link hosts, and never reads a body — it returns the
// redirect target, so it can't be pointed at anything else.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const MAX_HOPS = 3

// Host checks mirror `src/plugins/geo/googleMapsLink.ts`, which this
// Deno function can't import.

const isShortLink = (u: URL): boolean =>
  u.protocol === 'https:'
  && (u.hostname === 'maps.app.goo.gl' || (u.hostname === 'goo.gl' && u.pathname.startsWith('/maps/')))

const GOOGLE_HOST = /^(?:www\.|maps\.)?google\.[a-z]{2,3}(?:\.[a-z]{2})?$/

const isMapsUrl = (u: URL): boolean =>
  GOOGLE_HOST.test(u.hostname)
  && (u.hostname.startsWith('maps.') || u.pathname === '/maps' || u.pathname.startsWith('/maps/'))

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {...CORS_HEADERS, 'Content-Type': 'application/json'},
  })

const parseUrl = (value: unknown): URL | null => {
  if (typeof value !== 'string') return null
  try {
    return new URL(value)
  } catch {
    return null
  }
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', {headers: CORS_HEADERS})
  if (req.method !== 'POST') return json({error: 'POST {url}'}, 405)

  const body = await req.json().catch(() => null) as {url?: unknown} | null
  let current = parseUrl(body?.url)
  if (!current || !isShortLink(current)) return json({error: 'not a Google Maps short link'}, 400)

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const response = await fetch(current, {redirect: 'manual'})
    await response.body?.cancel()
    const next = parseUrl(response.headers.get('location'))
    if (!next) return json({error: `no redirect (HTTP ${response.status})`}, 502)
    if (isMapsUrl(next)) return json({url: next.toString()})
    if (!isShortLink(next)) return json({error: 'redirected outside Google Maps'}, 502)
    current = next
  }
  return json({error: 'too many redirects'}, 502)
})
