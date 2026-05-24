/** Map view component — renders pins for blocks under a root.
 *
 *  Single component, used both inline (over any block subtree) and
 *  globally (rooted at the Locations page). The `placesUnderBlock`
 *  query handles both shapes uniformly — Place blocks pin at their
 *  own coords, non-Place blocks with `location` pin at the referenced
 *  Place's coords.
 *
 *  Renders a graceful placeholder when the Google Maps API key is
 *  missing — the picker UX in Phases C / E still works, the map just
 *  doesn't render. */

import { useMemo } from 'react'
import {
  APIProvider,
  AdvancedMarker,
  Map,
  Pin,
  useAdvancedMarkerRef,
} from '@vis.gl/react-google-maps'
import { useRepo } from '@/context/repo.js'
import { useHandle } from '@/hooks/block.js'
import { useNavigateFromGlobalCommand } from '@/utils/navigation.js'
import { resolveApiKey } from './googlePlacesClient'
import { PLACES_UNDER_BLOCK_QUERY, type MapPin } from './query'

export interface MapViewProps {
  rootBlockId: string
  /** Override the default sizing — pass e.g. `h-full w-full` for fill. */
  className?: string
}

const DEFAULT_CENTER = {lat: 37.7749, lng: -122.4194}
const DEFAULT_ZOOM = 11
// Google requires a Map ID for AdvancedMarker. `DEMO_MAP_ID` works for
// dev; production users can override per-deployment if they want
// custom styling. See https://developers.google.com/maps/documentation/get-map-id
const MAP_ID = 'DEMO_MAP_ID'

const center = (pins: readonly MapPin[]): {lat: number; lng: number} => {
  if (pins.length === 0) return DEFAULT_CENTER
  let sumLat = 0
  let sumLng = 0
  for (const p of pins) {
    sumLat += p.lat
    sumLng += p.lng
  }
  return {lat: sumLat / pins.length, lng: sumLng / pins.length}
}

function MapMarker({
  pin,
  onPick,
}: {
  pin: MapPin
  onPick: (pin: MapPin) => void
}) {
  const [markerRef] = useAdvancedMarkerRef()
  return (
    <AdvancedMarker
      ref={markerRef}
      position={{lat: pin.lat, lng: pin.lng}}
      title={pin.name}
      onClick={() => onPick(pin)}
    >
      <Pin />
    </AdvancedMarker>
  )
}

const EMPTY_PINS: readonly MapPin[] = Object.freeze([])

function MapBody({rootBlockId, className}: MapViewProps) {
  const repo = useRepo()
  const navigate = useNavigateFromGlobalCommand()
  const pins = useHandle(
    repo.query[PLACES_UNDER_BLOCK_QUERY]({rootBlockId}),
    {selector: data => (data ?? EMPTY_PINS) as readonly MapPin[]},
  )
  const initialCenter = useMemo(() => center(pins), [pins])

  const onPick = (pin: MapPin) => {
    navigate({blockId: pin.blockId})
  }

  return (
    <div className={className ?? 'h-96 w-full overflow-hidden rounded-md border'}>
      <Map
        defaultCenter={initialCenter}
        defaultZoom={DEFAULT_ZOOM}
        mapId={MAP_ID}
        gestureHandling="cooperative"
      >
        {pins.map(pin => (
          <MapMarker key={`${pin.blockId}-${pin.placeId}`} pin={pin} onPick={onPick} />
        ))}
      </Map>
    </div>
  )
}

export function MapView(props: MapViewProps) {
  const apiKey = resolveApiKey()
  if (!apiKey) {
    return (
      <div className="rounded-md border border-dashed border-muted-foreground/40 p-4 text-sm text-muted-foreground">
        Map disabled — set <code>VITE_GOOGLE_MAPS_API_KEY</code> to enable.
      </div>
    )
  }
  return (
    <APIProvider apiKey={apiKey}>
      <MapBody {...props} />
    </APIProvider>
  )
}
MapView.displayName = 'MapView'
