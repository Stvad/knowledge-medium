/** Property editor for the `location` reference.
 *
 *  Surfaces three actions:
 *    1. Search — typeahead bundling local Places + Google Places. Pick
 *       any result, route through `createOrFindPlace`, and write the
 *       resolved Place id into `location`.
 *    2. Drop pin — opens a small map for free-form coordinate pick;
 *       creates an unnamed Place at those coords.
 *    3. Clear — sets the property back to undefined.
 *
 *  The "Use current location" button is wired in Phase F. */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Crosshair, Map as MapIcon, X } from 'lucide-react'
import {
  AdvancedMarker,
  APIProvider,
  Map,
  Pin,
} from '@vis.gl/react-google-maps'
import { type PropertyEditorProps } from '@/data/api'
import { useRepo } from '@/context/repo.js'
import { Button } from '@/components/ui/button.js'
import { createOrFindPlaceInteractive } from './placeNameCollision'
import { pickCurrentLocation } from './pickCurrentLocation'
import { resolveApiKey } from './googlePlacesClient'
import { usePlaceSearch, type PlaceSearchResult } from './usePlaceSearch'
import { typesProp } from '@/data/properties'
import { aliasesProp } from '@/data/internals/coreProperties'
import { PLACE_TYPE } from './blockTypes'
import { placeAddressProp } from './properties'

interface ResolvedLabel {
  blockId: string
  label: string
  address?: string
}

const labelFor = (block: { properties: Record<string, unknown> } | null | undefined): string | null => {
  if (!block) return null
  const aliases = block.properties[aliasesProp.name]
  if (Array.isArray(aliases)) {
    const alias = aliases.find((v): v is string =>
      typeof v === 'string' && !v.startsWith('place:') && !v.startsWith('geo:'))
    if (alias) return alias
  }
  const typesRaw = block.properties[typesProp.name]
  const isPlace = Array.isArray(typesRaw) && (typesRaw as unknown[]).includes(PLACE_TYPE)
  if (!isPlace) return null
  const addr = block.properties[placeAddressProp.name]
  if (typeof addr === 'string' && addr.length > 0) return addr
  return null
}

const addressOf = (block: { properties: Record<string, unknown> } | null | undefined): string | undefined => {
  if (!block) return undefined
  const addr = block.properties[placeAddressProp.name]
  return typeof addr === 'string' ? addr : undefined
}

export const LocationPropertyEditor = ({
  value,
  onChange,
}: PropertyEditorProps<string | undefined>) => {
  const repo = useRepo()
  const workspaceId = repo.activeWorkspaceId ?? ''
  const search = usePlaceSearch(repo)
  const [query, setQuery] = useState<string>('')
  const [resolved, setResolved] = useState<ResolvedLabel | null>(null)
  const [dropPinOpen, setDropPinOpen] = useState(false)
  const [pickingCurrent, setPickingCurrent] = useState(false)
  const [pickingError, setPickingError] = useState<string | null>(null)
  const [accuracyHint, setAccuracyHint] = useState<string | null>(null)

  // Hydrate the current Place's display label so the user sees "Blue
  // Bottle" instead of a uuid.
  useEffect(() => {
    let cancelled = false
    const hydrate = async () => {
      if (!value) {
        setResolved(null)
        return
      }
      const block = await repo.load(value)
      if (cancelled) return
      const label = labelFor(block) ?? value
      setResolved({blockId: value, label, address: addressOf(block)})
    }
    void hydrate()
    return () => { cancelled = true }
  }, [value, repo])

  const onPickLocal = useCallback((result: PlaceSearchResult) => {
    onChange(result.id)
    setQuery('')
  }, [onChange])

  const onPickGoogle = useCallback(async (result: PlaceSearchResult) => {
    if (!workspaceId || !search.client) return
    const placeId = result.id.replace(/^google:/, '')
    try {
      const details = await search.client.getDetails(placeId, {sessionToken: search.sessionToken})
      search.rotateSession()
      const resolved = await createOrFindPlaceInteractive(repo, workspaceId, {
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
      if (!resolved) return
      onChange(resolved.block.id)
      setQuery('')
    } catch (err) {
      console.warn('[geo] place resolve failed', err)
    }
  }, [workspaceId, search, repo, onChange])

  const onPick = useCallback((result: PlaceSearchResult) => {
    if (result.source === 'local') {
      onPickLocal(result)
    } else {
      void onPickGoogle(result)
    }
  }, [onPickLocal, onPickGoogle])

  const onDropPin = useCallback(async (lat: number, lng: number) => {
    if (!workspaceId) return
    const place = await createOrFindPlaceInteractive(repo, workspaceId, {name: '', lat, lng})
    if (!place) return
    onChange(place.block.id)
    setDropPinOpen(false)
  }, [workspaceId, repo, onChange])

  const onClear = useCallback(() => {
    onChange(undefined)
    setQuery('')
    setAccuracyHint(null)
  }, [onChange])

  const onUseCurrentLocation = useCallback(async () => {
    if (!workspaceId || pickingCurrent) return
    setPickingCurrent(true)
    setPickingError(null)
    try {
      const result = await pickCurrentLocation(repo, workspaceId)
      if (!result) {
        setPickingError('Could not get current location (permission denied or unavailable).')
        return
      }
      onChange(result.block.id)
      const snapTag = result.snappedToPOI ? 'POI' : 'pin'
      setAccuracyHint(`±${Math.round(result.accuracyM)}m · ${snapTag}`)
    } finally {
      setPickingCurrent(false)
    }
  }, [workspaceId, pickingCurrent, repo, onChange])

  if (!workspaceId) {
    return <div className="text-xs text-muted-foreground">No workspace selected.</div>
  }

  return (
    <div className="flex w-full flex-col gap-2">
      {resolved && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-2 py-1.5 text-sm">
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{resolved.label}</div>
            {resolved.address && (
              <div className="truncate text-xs text-muted-foreground">{resolved.address}</div>
            )}
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={onClear} aria-label="Clear location">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      <div className="flex flex-col gap-1">
        <input
          type="text"
          className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
          placeholder={resolved ? 'Change location…' : 'Search for a place…'}
          value={query}
          onChange={e => {
            const next = e.target.value
            setQuery(next)
            search.search(next)
          }}
        />
        {search.results.length > 0 && (
          <div className="max-h-56 overflow-y-auto rounded-md border border-border bg-popover">
            {search.results.map(r => (
              <button
                key={r.id}
                type="button"
                className="flex w-full flex-col items-start gap-0.5 border-b border-border/40 px-2 py-1.5 text-left text-sm last:border-b-0 hover:bg-muted"
                onClick={() => onPick(r)}
              >
                <span className="truncate">{r.label}</span>
                {r.detail && (
                  <span className="truncate text-xs text-muted-foreground">{r.detail}</span>
                )}
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {r.source}
                </span>
              </button>
            ))}
          </div>
        )}
        {search.loading && (
          <div className="text-xs text-muted-foreground">Searching…</div>
        )}
        {search.error && (
          <div className="text-xs text-destructive">{search.error}</div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setDropPinOpen(o => !o)}
        >
          <MapIcon className="mr-1.5 h-3.5 w-3.5" />
          {dropPinOpen ? 'Cancel pin' : 'Drop pin'}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pickingCurrent}
          onClick={() => { void onUseCurrentLocation() }}
        >
          <Crosshair className="mr-1.5 h-3.5 w-3.5" />
          {pickingCurrent ? 'Locating…' : 'Use current location'}
        </Button>
        {accuracyHint && (
          <span className="text-xs text-muted-foreground">{accuracyHint}</span>
        )}
      </div>
      {pickingError && (
        <div className="text-xs text-destructive">{pickingError}</div>
      )}

      {dropPinOpen && <DropPinMap onDrop={onDropPin} />}
    </div>
  )
}

const DROP_PIN_DEFAULT_CENTER = {lat: 37.7749, lng: -122.4194}
const DROP_PIN_DEFAULT_ZOOM = 11

function DropPinMap({onDrop}: {onDrop: (lat: number, lng: number) => void}) {
  const apiKey = useMemo(() => resolveApiKey(), [])
  const [pin, setPin] = useState<{lat: number; lng: number} | null>(null)

  if (!apiKey) {
    return (
      <div className="rounded-md border border-dashed border-muted-foreground/40 p-3 text-xs text-muted-foreground">
        Map unavailable — set <code>VITE_GOOGLE_MAPS_API_KEY</code>.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="h-64 w-full overflow-hidden rounded-md border">
        <APIProvider apiKey={apiKey}>
          <Map
            defaultCenter={DROP_PIN_DEFAULT_CENTER}
            defaultZoom={DROP_PIN_DEFAULT_ZOOM}
            mapId="DEMO_MAP_ID"
            gestureHandling="cooperative"
            onClick={ev => {
              const ll = ev.detail.latLng
              if (ll) setPin({lat: ll.lat, lng: ll.lng})
            }}
          >
            {pin && (
              <AdvancedMarker position={pin}>
                <Pin />
              </AdvancedMarker>
            )}
          </Map>
        </APIProvider>
      </div>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {pin
            ? `${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}`
            : 'Click on the map to drop a pin.'}
        </span>
        <Button
          type="button"
          variant="default"
          size="sm"
          disabled={!pin}
          onClick={() => pin && onDrop(pin.lat, pin.lng)}
        >
          Use this pin
        </Button>
      </div>
    </div>
  )
}
