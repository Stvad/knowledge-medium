/** Thin wrapper around the Google Places API (New) for the geo plugin.
 *  Exposes three operations:
 *
 *    - `autocomplete(input, ctx)`  — text-search suggestions for the `@`
 *      and property-editor pickers.
 *    - `getDetails(placeId, ctx)`  — full POI details for the user's
 *      selection. Reuses the same `sessionToken` as the prior
 *      autocomplete call so Google bills the pair as one unit.
 *    - `searchNearby({lat, lng, radiusM}, ctx)` — distance-ranked POIs
 *      near a coordinate. Drives the current-location picker (Phase F).
 *
 *  The client is stateless w.r.t. session tokens — callers create one
 *  via `newSessionToken()` at the start of a picker session and pass it
 *  through. That keeps the `@` autocomplete (one session per `@` press)
 *  and the property editor (one session per editor open) independently
 *  governed without coupling them through hidden client state.
 *
 *  Network access goes through an injected `fetch` impl (defaults to
 *  the global `fetch`) so tests can mock at the module boundary without
 *  monkey-patching `globalThis`. */

const PLACES_API_BASE = 'https://places.googleapis.com/v1'

const AUTOCOMPLETE_FIELD_MASK = [
  'suggestions.placePrediction.placeId',
  'suggestions.placePrediction.text',
  'suggestions.placePrediction.structuredFormat',
].join(',')

const DETAILS_FIELD_MASK = [
  'id',
  'displayName',
  'formattedAddress',
  'location',
  'googleMapsUri',
  'websiteUri',
  'internationalPhoneNumber',
  'types',
].join(',')

const NEARBY_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.googleMapsUri',
  'places.types',
].join(',')

export type FetchFn = typeof fetch

export interface GooglePlacesClientOptions {
  apiKey: string
  fetchImpl?: FetchFn
}

export interface AutocompleteContext {
  sessionToken: string
  /** Optional bias — when set, results are ranked higher if they're
   *  near `{lat, lng}` within `radiusM`. Used by the property editor
   *  when the user has already dropped a pin. */
  bias?: { lat: number; lng: number; radiusM?: number }
}

export interface AutocompleteSuggestion {
  placeId: string
  /** Primary label for the dropdown row. */
  primary: string
  /** Secondary line — address / locality for disambiguation. */
  secondary?: string
}

export interface PlaceDetails {
  placeId: string
  name: string
  lat: number
  lng: number
  address?: string
  googleMapsUrl?: string
  website?: string
  phone?: string
  categories: readonly string[]
}

export interface NearbyOptions {
  lat: number
  lng: number
  /** Radius in meters; clamped to Google's accepted range [0, 50000]. */
  radiusM?: number
  /** Max results; Google caps at 20 for nearby search. */
  maxResults?: number
}

export type NearbyCandidate = AutocompleteSuggestion & {
  lat: number
  lng: number
  /** Distance from the query coordinate in meters; populated for
   *  ranking and for "±18m" surfacing in the picker. */
  distanceM: number
  googleMapsUrl?: string
  categories: readonly string[]
}

export class GooglePlacesError extends Error {
  constructor(
    public readonly kind: 'http' | 'network' | 'invalid-response',
    public readonly status: number | null,
    message: string,
  ) {
    super(message)
    this.name = 'GooglePlacesError'
  }
}

const NEARBY_RADIUS_DEFAULT = 50
const NEARBY_RADIUS_MAX = 50_000
const NEARBY_MAX_RESULTS = 20

const clampRadius = (radiusM: number | undefined): number =>
  Math.min(NEARBY_RADIUS_MAX, Math.max(1, radiusM ?? NEARBY_RADIUS_DEFAULT))

/** Haversine distance, meters. Pure helper — exported for the
 *  `searchNearby` post-process and for any future caller that wants to
 *  surface accuracy bands. */
export const haversineMeters = (
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number => {
  const R = 6_371_008.8
  const toRad = (d: number): number => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const sLat = Math.sin(dLat / 2)
  const sLng = Math.sin(dLng / 2)
  const c = sLat * sLat
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sLng * sLng
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(c)))
}

interface GooglePrediction {
  placePrediction?: {
    placeId: string
    text?: { text?: string }
    structuredFormat?: {
      mainText?: { text?: string }
      secondaryText?: { text?: string }
    }
  }
}

interface GoogleDetailsResponse {
  id?: string
  displayName?: { text?: string }
  formattedAddress?: string
  location?: { latitude: number; longitude: number }
  googleMapsUri?: string
  websiteUri?: string
  internationalPhoneNumber?: string
  types?: string[]
}

interface GoogleNearbyResponse {
  places?: GoogleDetailsResponse[]
}

export interface GooglePlacesClient {
  autocomplete(input: string, ctx: AutocompleteContext): Promise<AutocompleteSuggestion[]>
  getDetails(placeId: string, ctx: { sessionToken?: string }): Promise<PlaceDetails>
  searchNearby(opts: NearbyOptions): Promise<NearbyCandidate[]>
}

/** Per-session token. Google requires a UUID-shaped string; the actual
 *  bytes are opaque — we just use the runtime's randomUUID. */
export const newSessionToken = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // Fallback for environments without crypto.randomUUID (older jsdom).
  // Quality doesn't matter — Google only checks the field exists.
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export const createGooglePlacesClient = (
  options: GooglePlacesClientOptions,
): GooglePlacesClient => {
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis)

  const headers = (fieldMask: string): HeadersInit => ({
    'Content-Type': 'application/json',
    'X-Goog-Api-Key': options.apiKey,
    'X-Goog-FieldMask': fieldMask,
  })

  const callJson = async <T>(
    url: string,
    init: { method: 'GET' | 'POST'; body?: unknown; fieldMask: string },
  ): Promise<T> => {
    let response: Response
    try {
      response = await fetchImpl(url, {
        method: init.method,
        headers: headers(init.fieldMask),
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      })
    } catch (err) {
      throw new GooglePlacesError(
        'network',
        null,
        err instanceof Error ? err.message : 'network error',
      )
    }
    if (!response.ok) {
      throw new GooglePlacesError(
        'http',
        response.status,
        `Places API ${init.method} ${url} → HTTP ${response.status}`,
      )
    }
    try {
      return (await response.json()) as T
    } catch {
      throw new GooglePlacesError('invalid-response', response.status, 'response was not valid JSON')
    }
  }

  const toDetails = (raw: GoogleDetailsResponse): PlaceDetails => {
    if (!raw.id || !raw.location) {
      throw new GooglePlacesError('invalid-response', null, 'Place details missing id or location')
    }
    return {
      placeId: raw.id,
      name: raw.displayName?.text ?? raw.formattedAddress ?? raw.id,
      lat: raw.location.latitude,
      lng: raw.location.longitude,
      address: raw.formattedAddress,
      googleMapsUrl: raw.googleMapsUri,
      website: raw.websiteUri,
      phone: raw.internationalPhoneNumber,
      categories: raw.types ?? [],
    }
  }

  return {
    autocomplete: async (input, ctx) => {
      if (input.trim().length === 0) return []
      type AutocompleteResponse = { suggestions?: GooglePrediction[] }
      const body: Record<string, unknown> = {
        input,
        sessionToken: ctx.sessionToken,
      }
      if (ctx.bias) {
        body.locationBias = {
          circle: {
            center: {latitude: ctx.bias.lat, longitude: ctx.bias.lng},
            radius: clampRadius(ctx.bias.radiusM),
          },
        }
      }
      const result = await callJson<AutocompleteResponse>(
        `${PLACES_API_BASE}/places:autocomplete`,
        {method: 'POST', body, fieldMask: AUTOCOMPLETE_FIELD_MASK},
      )
      const suggestions: AutocompleteSuggestion[] = []
      for (const s of result.suggestions ?? []) {
        const p = s.placePrediction
        if (!p?.placeId) continue
        suggestions.push({
          placeId: p.placeId,
          primary: p.structuredFormat?.mainText?.text ?? p.text?.text ?? p.placeId,
          secondary: p.structuredFormat?.secondaryText?.text,
        })
      }
      return suggestions
    },

    getDetails: async (placeId, ctx) => {
      const url = new URL(`${PLACES_API_BASE}/places/${encodeURIComponent(placeId)}`)
      if (ctx.sessionToken) url.searchParams.set('sessionToken', ctx.sessionToken)
      const raw = await callJson<GoogleDetailsResponse>(url.toString(), {
        method: 'GET',
        fieldMask: DETAILS_FIELD_MASK,
      })
      return toDetails(raw)
    },

    searchNearby: async (opts) => {
      const radius = clampRadius(opts.radiusM)
      const max = Math.min(NEARBY_MAX_RESULTS, Math.max(1, opts.maxResults ?? 5))
      const body = {
        locationRestriction: {
          circle: {
            center: {latitude: opts.lat, longitude: opts.lng},
            radius,
          },
        },
        maxResultCount: max,
        rankPreference: 'DISTANCE',
      }
      const result = await callJson<GoogleNearbyResponse>(
        `${PLACES_API_BASE}/places:searchNearby`,
        {method: 'POST', body, fieldMask: NEARBY_FIELD_MASK},
      )
      const center = {lat: opts.lat, lng: opts.lng}
      const candidates: NearbyCandidate[] = []
      for (const raw of result.places ?? []) {
        if (!raw.id || !raw.location) continue
        candidates.push({
          placeId: raw.id,
          primary: raw.displayName?.text ?? raw.formattedAddress ?? raw.id,
          secondary: raw.formattedAddress,
          lat: raw.location.latitude,
          lng: raw.location.longitude,
          distanceM: haversineMeters(center, {lat: raw.location.latitude, lng: raw.location.longitude}),
          googleMapsUrl: raw.googleMapsUri,
          categories: raw.types ?? [],
        })
      }
      candidates.sort((a, b) => a.distanceM - b.distanceM)
      return candidates
    },
  }
}

/** Resolve the Google Maps API key from the Vite env. Returns `null`
 *  when missing — callers gate the autocomplete entirely (no Google
 *  results, only local Place matches) rather than throwing. */
export const resolveApiKey = (): string | null => {
  const env = import.meta.env as Record<string, string | undefined>
  return env.VITE_GOOGLE_MAPS_API_KEY ?? null
}
