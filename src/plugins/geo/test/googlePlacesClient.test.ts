import { describe, expect, it, vi } from 'vitest'
import {
  createGooglePlacesClient,
  haversineMeters,
  newSessionToken,
  type FetchFn,
} from '../googlePlacesClient'

const okJson = (body: unknown, init?: { status?: number }): Response =>
  new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {'Content-Type': 'application/json'},
  })

const stubFetch = (responses: Response[]): { fetchImpl: FetchFn; calls: Array<{url: string; init: RequestInit | undefined}> } => {
  const calls: Array<{url: string; init: RequestInit | undefined}> = []
  let i = 0
  const fetchImpl: FetchFn = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push({url, init})
    const next = responses[i++]
    if (!next) throw new Error(`stub fetch ran out at call #${i}`)
    return next
  }
  return {fetchImpl, calls}
}

const headerValue = (init: RequestInit | undefined, name: string): string | null => {
  const headers = init?.headers
  if (!headers) return null
  if (headers instanceof Headers) return headers.get(name)
  if (Array.isArray(headers)) {
    for (const [k, v] of headers) if (k.toLowerCase() === name.toLowerCase()) return v
    return null
  }
  const record = headers as Record<string, string>
  for (const [k, v] of Object.entries(record)) {
    if (k.toLowerCase() === name.toLowerCase()) return v
  }
  return null
}

describe('autocomplete', () => {
  it('sends the session token in the body and normalises suggestions', async () => {
    const {fetchImpl, calls} = stubFetch([
      okJson({
        suggestions: [
          {placePrediction: {
            placeId: 'ChIJabc',
            text: {text: 'Dandelion Chocolate, Valencia St, San Francisco'},
            structuredFormat: {
              mainText: {text: 'Dandelion Chocolate'},
              secondaryText: {text: 'Valencia St, San Francisco'},
            },
          }},
        ],
      }),
    ])
    const client = createGooglePlacesClient({apiKey: 'key-1', fetchImpl})

    const out = await client.autocomplete('dandelion', {sessionToken: 'tok-1'})

    expect(out).toEqual([{
      placeId: 'ChIJabc',
      primary: 'Dandelion Chocolate',
      secondary: 'Valencia St, San Francisco',
    }])
    const body = JSON.parse(calls[0].init!.body as string) as Record<string, unknown>
    expect(body.input).toBe('dandelion')
    expect(body.sessionToken).toBe('tok-1')
    expect(headerValue(calls[0].init, 'X-Goog-Api-Key')).toBe('key-1')
  })

  it('skips the network round-trip for empty input', async () => {
    const {fetchImpl, calls} = stubFetch([])
    const client = createGooglePlacesClient({apiKey: 'key-1', fetchImpl})
    expect(await client.autocomplete('   ', {sessionToken: 'tok-1'})).toEqual([])
    expect(calls).toHaveLength(0)
  })
})

describe('getDetails', () => {
  it('returns normalised place details and reuses the session token via query string', async () => {
    const {fetchImpl, calls} = stubFetch([
      okJson({
        id: 'ChIJabc',
        displayName: {text: 'Dandelion Chocolate'},
        formattedAddress: '740 Valencia St',
        location: {latitude: 37.761, longitude: -122.421},
        googleMapsUri: 'https://maps.google.com/?cid=1',
        websiteUri: 'https://dandelion.example',
        internationalPhoneNumber: '+1 415',
        types: ['cafe', 'restaurant'],
      }),
    ])
    const client = createGooglePlacesClient({apiKey: 'key-1', fetchImpl})

    const out = await client.getDetails('ChIJabc', {sessionToken: 'tok-1'})

    expect(out).toEqual({
      placeId: 'ChIJabc',
      name: 'Dandelion Chocolate',
      lat: 37.761,
      lng: -122.421,
      address: '740 Valencia St',
      googleMapsUrl: 'https://maps.google.com/?cid=1',
      website: 'https://dandelion.example',
      phone: '+1 415',
      categories: ['cafe', 'restaurant'],
    })
    expect(calls[0].url).toContain('places/ChIJabc')
    expect(calls[0].url).toContain('sessionToken=tok-1')
  })

  it('reuses one session token across an autocomplete-then-details sequence', async () => {
    const {fetchImpl, calls} = stubFetch([
      okJson({suggestions: [{placePrediction: {placeId: 'ChIJabc', text: {text: 'Cafe'}}}]}),
      okJson({id: 'ChIJabc', displayName: {text: 'Cafe'}, location: {latitude: 0, longitude: 0}}),
    ])
    const client = createGooglePlacesClient({apiKey: 'key-1', fetchImpl})
    const token = newSessionToken()

    await client.autocomplete('cafe', {sessionToken: token})
    await client.getDetails('ChIJabc', {sessionToken: token})

    const ac = JSON.parse(calls[0].init!.body as string) as Record<string, unknown>
    expect(ac.sessionToken).toBe(token)
    expect(calls[1].url).toContain(`sessionToken=${token}`)
  })

  it('throws GooglePlacesError with kind=http on 4xx/5xx', async () => {
    const {fetchImpl} = stubFetch([okJson({error: 'quota'}, {status: 429})])
    const client = createGooglePlacesClient({apiKey: 'key-1', fetchImpl})
    await expect(client.getDetails('ChIJabc', {})).rejects.toMatchObject({
      name: 'GooglePlacesError',
      kind: 'http',
      status: 429,
    })
  })

  it('throws GooglePlacesError with kind=network when fetch rejects', async () => {
    const fetchImpl: FetchFn = vi.fn(() => Promise.reject(new Error('socket reset')))
    const client = createGooglePlacesClient({apiKey: 'key-1', fetchImpl})
    await expect(client.getDetails('ChIJabc', {})).rejects.toMatchObject({
      name: 'GooglePlacesError',
      kind: 'network',
      status: null,
    })
  })
})

describe('searchNearby', () => {
  it('returns candidates sorted by distance with haversine measurements', async () => {
    const center = {lat: 37.761, lng: -122.421}
    // far ~250m east, near ~25m east — order in the response is far, near.
    const farLng = center.lng + 0.003
    const nearLng = center.lng + 0.00028
    const {fetchImpl, calls} = stubFetch([
      okJson({
        places: [
          {id: 'ChIJfar', displayName: {text: 'Far'}, location: {latitude: center.lat, longitude: farLng}, types: ['cafe']},
          {id: 'ChIJnear', displayName: {text: 'Near'}, location: {latitude: center.lat, longitude: nearLng}, types: ['cafe']},
        ],
      }),
    ])
    const client = createGooglePlacesClient({apiKey: 'key-1', fetchImpl})

    const out = await client.searchNearby({lat: center.lat, lng: center.lng, radiusM: 500})

    expect(out.map(c => c.placeId)).toEqual(['ChIJnear', 'ChIJfar'])
    expect(out[0].distanceM).toBeLessThan(out[1].distanceM)
    const body = JSON.parse(calls[0].init!.body as string) as {locationRestriction: {circle: {radius: number}}}
    expect(body.locationRestriction.circle.radius).toBe(500)
  })

  it('clamps radius to Google’s maximum', async () => {
    const {fetchImpl, calls} = stubFetch([okJson({places: []})])
    const client = createGooglePlacesClient({apiKey: 'key-1', fetchImpl})
    await client.searchNearby({lat: 0, lng: 0, radiusM: 999_999})
    const body = JSON.parse(calls[0].init!.body as string) as {locationRestriction: {circle: {radius: number}}}
    expect(body.locationRestriction.circle.radius).toBe(50_000)
  })
})

describe('haversineMeters', () => {
  it('returns ~0 for identical points', () => {
    expect(haversineMeters({lat: 37.761, lng: -122.421}, {lat: 37.761, lng: -122.421}))
      .toBeLessThan(0.01)
  })

  it('approximates a known distance (~111km per degree latitude at equator)', () => {
    const d = haversineMeters({lat: 0, lng: 0}, {lat: 1, lng: 0})
    expect(d).toBeGreaterThan(110_000)
    expect(d).toBeLessThan(112_000)
  })
})
