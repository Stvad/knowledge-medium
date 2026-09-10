/** Viewport math for the map view — "show me all the pins".
 *
 *  Kept out of the component so it can be tested without a Google Maps
 *  instance: the component's only job is to call `applyBounds` when the
 *  box changes. */

import type { MapPin } from './query'

/** Matches `google.maps.LatLngBoundsLiteral`. */
export interface MapBounds {
  north: number
  south: number
  east: number
  west: number
}

/** Just enough of `google.maps.Map` for the fit. */
export interface FittableMap {
  fitBounds(bounds: MapBounds, padding?: number): void
  setCenter(center: {lat: number; lng: number}): void
  setZoom(zoom: number): void
}

/** Breathing room so pins don't sit on the map edge. */
export const FIT_PADDING_PX = 32

/** Below this, a box is a point: `fitBounds` on it zooms to max. */
const POINT_EPSILON = 1e-6

// Short-circuit in range: the modulo perturbs the last bits of an
// ordinary longitude, and these values are compared for equality to
// decide whether the camera needs to move at all.
const wrapLng = (lng: number): number =>
  lng >= -180 && lng <= 180 ? lng : ((((lng + 180) % 360) + 360) % 360) - 180

/** Smallest box containing every pin, or null when there are none.
 *
 *  Longitude takes the smallest arc covering the pins rather than
 *  min/max, so a Tokyo + Honolulu pair spans the Pacific instead of the
 *  long way round the globe. `west > east` then means the box crosses
 *  the antimeridian — which is how `google.maps.LatLngBounds` already
 *  reads a literal, so no special casing downstream. */
export const pinsBounds = (pins: readonly MapPin[]): MapBounds | null => {
  if (pins.length === 0) return null

  let north = -Infinity
  let south = Infinity
  for (const pin of pins) {
    north = Math.max(north, pin.lat)
    south = Math.min(south, pin.lat)
  }

  const lngs = pins.map(pin => wrapLng(pin.lng)).sort((a, b) => a - b)
  // The box is the complement of the widest empty arc between
  // neighbouring pins, so it starts just after that gap and ends just
  // before it. The wrap-around gap (last → first) is the naive
  // min/max box, and wins whenever nothing straddles the antimeridian.
  let gapStart = lngs.length - 1
  let widest = lngs[0] + 360 - lngs[lngs.length - 1]
  for (let i = 0; i < lngs.length - 1; i++) {
    const gap = lngs[i + 1] - lngs[i]
    if (gap > widest) {
      widest = gap
      gapStart = i
    }
  }

  return {
    north,
    south,
    west: lngs[(gapStart + 1) % lngs.length],
    east: lngs[gapStart],
  }
}

const lngSpan = (bounds: MapBounds): number =>
  bounds.east >= bounds.west ? bounds.east - bounds.west : bounds.east + 360 - bounds.west

/** Identity of a box, for "has the view actually changed" checks. */
export const boundsKey = (bounds: MapBounds): string =>
  `${bounds.north},${bounds.south},${bounds.east},${bounds.west}`

/** Point the map at `bounds`. A one-pin (or all-pins-coincident) box has
 *  no extent for `fitBounds` to work from — it would zoom to street
 *  level — so those centre at `pointZoom` instead. */
export const applyBounds = (
  map: FittableMap,
  bounds: MapBounds,
  pointZoom: number,
): void => {
  if (bounds.north - bounds.south < POINT_EPSILON && lngSpan(bounds) < POINT_EPSILON) {
    map.setCenter({lat: bounds.north, lng: bounds.east})
    map.setZoom(pointZoom)
    return
  }
  map.fitBounds(bounds, FIT_PADDING_PX)
}
