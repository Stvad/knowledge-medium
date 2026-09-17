/** Map view component — renders pins for blocks under a root.
 *
 *  Single component, used both inline (over any block subtree, e.g. a
 *  Place page's own mini-map) and globally (rooted at the Locations
 *  page). The `placesUnderBlock` query handles both shapes uniformly —
 *  Place blocks pin at their own coords, non-Place blocks with
 *  `location` pin at the referenced Place's coords.
 *
 *  Click a marker → opens an InfoWindow with the place name, address,
 *  and an "Open" button that navigates to the source block. This
 *  preview-on-click pattern lets the user scan a busy map without
 *  losing the map context.
 *
 *  Renders a graceful placeholder when the Google Maps API key is
 *  missing — the picker UX in Phases C / E still works, the map just
 *  doesn't render. */

import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import {
  APIProvider,
  AdvancedMarker,
  InfoWindow,
  Map,
  Pin,
  useAdvancedMarkerRef,
  useMap,
} from '@vis.gl/react-google-maps'
import { useRepo } from '@/context/repo.js'
import { useHandle } from '@/hooks/block.js'
import { useBlockOpener } from '@/utils/navigation.js'
import { resolveApiKey } from './googlePlacesClient'
import { applyBounds, boundsKey, pinsBounds } from './mapViewport'
import { PLACES_UNDER_BLOCK_QUERY, type MapPin } from './query'

export interface MapViewProps {
  rootBlockId: string
  /** Override the default sizing — pass e.g. `h-full w-full` for fill. */
  className?: string
  /** Zoom for the cases with no box to fit — no pins at all, or every
   *  pin at one coordinate (a Place's own mini-map). Anything with
   *  extent is framed by its bounding box instead. Defaults to 11
   *  (city-level); per-Place mini-maps should pass ~15. */
  defaultZoom?: number
}

const DEFAULT_CENTER = {lat: 37.7749, lng: -122.4194}
const DEFAULT_ZOOM = 11
// Google requires a Map ID for AdvancedMarker. `DEMO_MAP_ID` works for
// dev; production users can override per-deployment if they want
// custom styling. See https://developers.google.com/maps/documentation/get-map-id
const MAP_ID = 'DEMO_MAP_ID'

const pinKey = (pin: MapPin): string => `${pin.blockId}-${pin.placeId}`

/** Frames every pin.
 *
 *  `<Map>`'s `defaultCenter` / `defaultZoom` are read once, when the map
 *  is created — and the pins arrive from an async query a tick later, so
 *  a map left to those props sits on DEFAULT_CENTER forever with the
 *  pins off screen. Driving the camera imperatively is the only way to
 *  react to pins that land after mount.
 *
 *  Refits only when the box itself moves: `pins` gets a fresh array
 *  identity on every re-resolve of the query, and refitting on those
 *  would yank the map back from wherever the user just panned. */
export function FitPinsToViewport({
  pins,
  pointZoom,
}: {
  pins: readonly MapPin[]
  pointZoom: number
}) {
  const map = useMap()
  const bounds = useMemo(() => pinsBounds(pins), [pins])
  const fitted = useRef<string | null>(null)

  useEffect(() => {
    if (!map || !bounds) return
    const key = `${boundsKey(bounds)}@${pointZoom}`
    if (fitted.current === key) return
    fitted.current = key
    applyBounds(map, bounds, pointZoom)
  }, [map, bounds, pointZoom])

  return null
}

function MapMarker({
  pin,
  isOpen,
  onSelect,
  onClose,
  onOpen,
}: {
  pin: MapPin
  isOpen: boolean
  onSelect: (pin: MapPin) => void
  onClose: () => void
  onOpen: (event: MouseEvent, pin: MapPin) => void
}) {
  const [markerRef, marker] = useAdvancedMarkerRef()
  return (
    <>
      <AdvancedMarker
        ref={markerRef}
        position={{lat: pin.lat, lng: pin.lng}}
        title={pin.name}
        onClick={() => onSelect(pin)}
      >
        <Pin />
      </AdvancedMarker>
      {isOpen && marker && (
        <InfoWindow
          anchor={marker}
          onCloseClick={onClose}
          headerContent={<span className="text-sm font-medium">{pin.name}</span>}
        >
          <div className="flex flex-col gap-2 py-1 text-sm">
            {pin.address && (
              <p className="text-muted-foreground">{pin.address}</p>
            )}
            <button
              type="button"
              className="self-start rounded border border-border bg-background px-2 py-1 text-xs hover:bg-muted"
              onClick={(event) => onOpen(event, pin)}
            >
              Open
            </button>
          </div>
        </InfoWindow>
      )}
    </>
  )
}

const EMPTY_PINS: readonly MapPin[] = Object.freeze([])

function MapBody({rootBlockId, className, defaultZoom}: MapViewProps) {
  const repo = useRepo()
  const openBlock = useBlockOpener()
  const pins = useHandle(
    repo.query[PLACES_UNDER_BLOCK_QUERY]({rootBlockId}),
    {selector: data => (data ?? EMPTY_PINS) as readonly MapPin[]},
  )
  const [openPinId, setOpenPinId] = useState<string | null>(null)
  const zoom = defaultZoom ?? DEFAULT_ZOOM

  return (
    <div className={className ?? 'h-96 w-full overflow-hidden rounded-md border'}>
      <Map
        defaultCenter={DEFAULT_CENTER}
        defaultZoom={zoom}
        mapId={MAP_ID}
        gestureHandling="cooperative"
      >
        <FitPinsToViewport pins={pins} pointZoom={zoom}/>
        {pins.map(pin => {
          const key = pinKey(pin)
          return (
            <MapMarker
              key={key}
              pin={pin}
              isOpen={openPinId === key}
              onSelect={p => setOpenPinId(pinKey(p))}
              onClose={() => setOpenPinId(null)}
              onOpen={(event, p) => {
                setOpenPinId(null)
                openBlock(event, {blockId: p.blockId})
              }}
            />
          )
        })}
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
