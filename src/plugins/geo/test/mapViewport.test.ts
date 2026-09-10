/** Bounding-box math behind "show me all the pins". */

import { describe, expect, it, vi } from 'vitest'
import { applyBounds, FIT_PADDING_PX, pinsBounds } from '../mapViewport'
import type { MapPin } from '../query'

const pin = (lat: number, lng: number): MapPin => ({
  blockId: `b-${lat}-${lng}`,
  placeId: `p-${lat}-${lng}`,
  name: 'somewhere',
  lat,
  lng,
})

const fakeMap = () => ({
  fitBounds: vi.fn(),
  setCenter: vi.fn(),
  setZoom: vi.fn(),
})

describe('pinsBounds', () => {
  it('returns null with no pins', () => {
    expect(pinsBounds([])).toBeNull()
  })

  it('spans every pin', () => {
    expect(pinsBounds([pin(37.77, -122.42), pin(40.71, -74.01), pin(39, -100)])).toEqual({
      north: 40.71,
      south: 37.77,
      east: -74.01,
      west: -122.42,
    })
  })

  it('takes the short way round for pins straddling the antimeridian', () => {
    // Tokyo + Honolulu: naive min/max longitude would span the other
    // ~215° of the globe and frame Africa.
    const bounds = pinsBounds([pin(35.68, 139.77), pin(21.31, -157.86)])
    expect(bounds).toEqual({north: 35.68, south: 21.31, west: 139.77, east: -157.86})
  })

  it('normalizes longitudes outside [-180, 180]', () => {
    expect(pinsBounds([pin(0, 190)])).toEqual({north: 0, south: 0, west: -170, east: -170})
  })
})

describe('applyBounds', () => {
  it('fits a box with extent', () => {
    const map = fakeMap()
    const bounds = {north: 40.71, south: 37.77, east: -74.01, west: -122.42}
    applyBounds(map, bounds, 11)
    expect(map.fitBounds).toHaveBeenCalledWith(bounds, FIT_PADDING_PX)
    expect(map.setZoom).not.toHaveBeenCalled()
  })

  it('centers at the fallback zoom when every pin shares one coordinate', () => {
    // fitBounds on a zero-extent box zooms to street level, which is
    // the whole reason this branch exists.
    const map = fakeMap()
    applyBounds(map, pinsBounds([pin(48.86, 2.35), pin(48.86, 2.35)])!, 15)
    expect(map.fitBounds).not.toHaveBeenCalled()
    expect(map.setCenter).toHaveBeenCalledWith({lat: 48.86, lng: 2.35})
    expect(map.setZoom).toHaveBeenCalledWith(15)
  })
})
