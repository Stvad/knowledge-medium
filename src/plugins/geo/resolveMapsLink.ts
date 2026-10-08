/** Google Maps link → `PlaceCandidate`. Prefers the Google POI the link
 *  points at (so the Place dedups with one picked via `@` autocomplete),
 *  and falls back to the name and position the link itself carries when
 *  there is no API key or Google finds no match. */

import type { PlaceCandidate } from './createOrFindPlace'
import {
  haversineMeters,
  type GooglePlacesClient,
  type PlaceDetails,
} from './googlePlacesClient'
import { parseGoogleMapsUrl, type ParsedMapsLink } from './googleMapsLink'

/** A link this module can't turn into a place; `message` is user-facing. */
export class MapsLinkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MapsLinkError'
  }
}

export interface ResolveMapsLinkDeps {
  /** `null` without an API key. */
  client: Pick<GooglePlacesClient, 'getDetails' | 'searchText'> | null
  /** Short link → the full URL it redirects to. */
  expandShortLink: (url: string) => Promise<string>
}

type FullLink = Extract<ParsedMapsLink, {kind: 'full'}>

/** How far a search result may sit from the linked coordinates and still
 *  be the linked place. Both come from Google's own data, so a real match
 *  is metres off; the slack is for sprawling venues. */
const MATCH_RADIUS_M = 250
const BIAS_RADIUS_M = 2_000

const cidOf = (googleMapsUrl: string | undefined): string | null => {
  if (!googleMapsUrl) return null
  try {
    return new URL(googleMapsUrl).searchParams.get('cid')
  } catch {
    return null
  }
}

/** Search only CONFIRMS which place the link means — the result with the
 *  link's CID, else the one nearest the link's own coordinates — and never
 *  picks a best guess: a neighbour or a top-ranked result is a different place. */
const pickMatch = (results: readonly PlaceDetails[], link: FullLink): PlaceDetails | null => {
  if (link.cid) return results.find(r => cidOf(r.googleMapsUrl) === link.cid) ?? null
  const at = link.coords
  if (!at) return null
  let nearest: PlaceDetails | null = null
  let nearestM = MATCH_RADIUS_M
  for (const r of results) {
    const m = haversineMeters(at, r)
    if (m <= nearestM) [nearest, nearestM] = [r, m]
  }
  return nearest
}

const findOnGoogle = async (
  client: NonNullable<ResolveMapsLinkDeps['client']>,
  link: FullLink,
): Promise<PlaceDetails | null> => {
  if (link.placeId) return client.getDetails(link.placeId, {})
  // A CID-only link (`?cid=…`) ends here and is refused by `fromLink`: the
  // Places API has no CID lookup, and the cid page doesn't redirect to one.
  if (!link.query) return null
  // Nothing could confirm a result, so don't pay for the search.
  if (!link.cid && !link.coords) return null
  const center = link.coords ?? link.viewport
  const results = await client.searchText(link.query, {
    bias: center && {...center, radiusM: BIAS_RADIUS_M},
  })
  return pickMatch(results, link)
}

const fromDetails = (details: PlaceDetails): PlaceCandidate => ({
  name: details.name,
  lat: details.lat,
  lng: details.lng,
  address: details.address,
  googlePlaceId: details.placeId,
  googleMapsUrl: details.googleMapsUrl,
  website: details.website,
  phone: details.phone,
  categories: details.categories,
})

/** A place link's text is "<name>, <address…>" — the name is the head. */
const nameFromQuery = (query: string | undefined): string =>
  query?.split(',')[0]?.trim() ?? ''

const fromLink = (link: FullLink, url: string): PlaceCandidate => {
  const position = link.coords
  if (!position) {
    throw new MapsLinkError("The link doesn't identify one place — open it and copy the place's full URL.")
  }
  return {
    name: nameFromQuery(link.query),
    lat: position.lat,
    lng: position.lng,
    googleMapsUrl: link.cid ? `https://maps.google.com/?cid=${link.cid}` : url,
  }
}

const parseFull = (url: string): FullLink => {
  const parsed = parseGoogleMapsUrl(url)
  if (parsed?.kind !== 'full') throw new MapsLinkError(`Not a Google Maps place link: ${url}`)
  return parsed
}

export const resolveMapsLink = async (
  url: string,
  deps: ResolveMapsLinkDeps,
): Promise<PlaceCandidate> => {
  const parsed = parseGoogleMapsUrl(url)
  if (!parsed) throw new MapsLinkError(`Not a Google Maps link: ${url}`)
  const link = parsed.kind === 'short' ? parseFull(await deps.expandShortLink(url)) : parsed

  const match = deps.client ? await findOnGoogle(deps.client, link) : null
  return match ? fromDetails(match) : fromLink(link, url)
}
