// @vitest-environment happy-dom
/** The camera has to follow pins that arrive AFTER the map is created —
 *  `<Map>`'s `defaultCenter` / `defaultZoom` are read once at creation,
 *  and the pin query resolves a tick later. Google Maps is mocked at the
 *  module boundary; `useMap` hands back a spy camera. */

import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const stub = vi.hoisted(() => ({
  map: {fitBounds: vi.fn(), setCenter: vi.fn(), setZoom: vi.fn()} as Record<string, ReturnType<typeof vi.fn>>,
  current: null as unknown,
  pins: [] as unknown[],
}))

type Wrapper = {children?: React.ReactNode}

vi.mock('@vis.gl/react-google-maps', () => ({
  APIProvider: ({children}: Wrapper) => children,
  AdvancedMarker: () => null,
  InfoWindow: () => null,
  Map: ({children}: Wrapper) => children,
  Pin: () => null,
  useAdvancedMarkerRef: () => [vi.fn(), null],
  useMap: () => stub.current,
}))

vi.mock('../googlePlacesClient', async (importActual) => ({
  ...(await importActual<typeof import('../googlePlacesClient')>()),
  resolveApiKey: () => 'test-key',
}))

vi.mock('@/context/repo.js', () => ({
  useRepo: () => ({query: {'geo.placesUnderBlock': () => ({})}}),
}))

vi.mock('@/hooks/block.js', () => ({useHandle: () => stub.pins}))

import { FitPinsToViewport, MapView } from '../MapView'
import { FIT_PADDING_PX } from '../mapViewport'
import type { MapPin } from '../query'

const pin = (lat: number, lng: number): MapPin => ({
  blockId: `b-${lat}-${lng}`,
  placeId: `p-${lat}-${lng}`,
  name: 'somewhere',
  lat,
  lng,
})

beforeEach(() => {
  stub.current = stub.map
  stub.pins = []
  for (const spy of Object.values(stub.map)) spy.mockReset()
})

describe('MapView', () => {
  it('fits the rendered map to its pins', () => {
    stub.pins = [pin(37.77, -122.42), pin(40.71, -74.01)]
    render(<MapView rootBlockId="root"/>)
    expect(stub.map.fitBounds).toHaveBeenCalledWith(
      {north: 40.71, south: 37.77, west: -122.42, east: -74.01},
      FIT_PADDING_PX,
    )
  })

  it('centers a single-place mini-map at the zoom it was given', () => {
    stub.pins = [pin(48.86, 2.35)]
    render(<MapView rootBlockId="root" defaultZoom={15}/>)
    expect(stub.map.setCenter).toHaveBeenCalledWith({lat: 48.86, lng: 2.35})
    expect(stub.map.setZoom).toHaveBeenCalledWith(15)
  })
})

describe('FitPinsToViewport', () => {
  it('frames pins that arrive after the map is created', () => {
    const {rerender} = render(<FitPinsToViewport pins={[]} pointZoom={11}/>)
    expect(stub.map.fitBounds).not.toHaveBeenCalled()

    rerender(<FitPinsToViewport pins={[pin(37.77, -122.42), pin(40.71, -74.01)]} pointZoom={11}/>)
    expect(stub.map.fitBounds).toHaveBeenCalledWith(
      {north: 40.71, south: 37.77, west: -122.42, east: -74.01},
      FIT_PADDING_PX,
    )
  })

  it('leaves the camera alone when a re-resolve returns the same pins', () => {
    // The query hands back a fresh array on every re-resolve; refitting
    // on those would yank the map back from wherever the user panned.
    const pins = [pin(37.77, -122.42), pin(40.71, -74.01)]
    const {rerender} = render(<FitPinsToViewport pins={pins} pointZoom={11}/>)
    expect(stub.map.fitBounds).toHaveBeenCalledTimes(1)

    rerender(<FitPinsToViewport pins={[...pins]} pointZoom={11}/>)
    expect(stub.map.fitBounds).toHaveBeenCalledTimes(1)

    rerender(<FitPinsToViewport pins={[...pins, pin(47.6, -122.33)]} pointZoom={11}/>)
    expect(stub.map.fitBounds).toHaveBeenCalledTimes(2)
  })

  it('waits for the map instance', () => {
    // `useMap` is null until the Map component has created its instance.
    stub.current = null
    const {rerender} = render(<FitPinsToViewport pins={[pin(37.77, -122.42), pin(40.71, -74.01)]} pointZoom={11}/>)
    expect(stub.map.fitBounds).not.toHaveBeenCalled()

    stub.current = stub.map
    rerender(<FitPinsToViewport pins={[pin(37.77, -122.42), pin(40.71, -74.01)]} pointZoom={11}/>)
    expect(stub.map.fitBounds).toHaveBeenCalledTimes(1)
  })
})
