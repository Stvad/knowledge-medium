/** Shared "use my current location" flow — used by both the `@`
 *  autocomplete sentinel and the property editor's button.
 *
 *  v1 strategy: get a browser geolocation fix, run a nearby-POI search,
 *  pick the closest candidate within 50m (so a casual fix doesn't snap
 *  to a 200m-away coffee shop), fall back to an ad-hoc coord pin. The
 *  full Embark-style "show a picker" UI is a follow-up.
 *
 *  Returns the resolved Place block, or `null` if the user denied
 *  permission / no fix was obtained. */

import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { CurrentLocationError, getCurrentPosition } from './currentLocation'
import { createOrFindPlace } from './createOrFindPlace'
import {
  GooglePlacesError,
  createGooglePlacesClient,
  newSessionToken,
  resolveApiKey,
  type GooglePlacesClient,
} from './googlePlacesClient'

const SNAP_RADIUS_M = 50

const buildClient = (): GooglePlacesClient | null => {
  const key = resolveApiKey()
  return key ? createGooglePlacesClient({apiKey: key}) : null
}

export interface PickCurrentLocationResult {
  block: Block
  /** Accuracy radius from the browser fix in meters — surface this in
   *  the UI as "±18m" so the user knows when to second-guess the snap. */
  accuracyM: number
  /** True when we snapped to a Google POI; false when we dropped an
   *  ad-hoc coord pin. */
  snappedToPOI: boolean
}

export const pickCurrentLocation = async (
  repo: Repo,
  workspaceId: string,
): Promise<PickCurrentLocationResult | null> => {
  let fix
  try {
    fix = await getCurrentPosition()
  } catch (err) {
    if (err instanceof CurrentLocationError) {
      console.warn(`[geo] current location ${err.kind}: ${err.message}`)
      return null
    }
    throw err
  }

  const client = buildClient()
  if (client) {
    try {
      const nearby = await client.searchNearby({
        lat: fix.lat,
        lng: fix.lng,
        radiusM: SNAP_RADIUS_M,
        maxResults: 5,
      })
      const closest = nearby[0]
      if (closest && closest.distanceM <= SNAP_RADIUS_M) {
        const sessionToken = newSessionToken()
        const details = await client.getDetails(closest.placeId, {sessionToken})
        const block = await createOrFindPlace(repo, workspaceId, {
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
        return {block, accuracyM: fix.accuracy, snappedToPOI: true}
      }
    } catch (err) {
      if (err instanceof GooglePlacesError) {
        console.warn('[geo] nearby search failed; falling back to ad-hoc pin', err)
      } else {
        throw err
      }
    }
  }

  // Fall back to an ad-hoc coord pin.
  const block = await createOrFindPlace(repo, workspaceId, {
    name: '',
    lat: fix.lat,
    lng: fix.lng,
  })
  return {block, accuracyM: fix.accuracy, snappedToPOI: false}
}
