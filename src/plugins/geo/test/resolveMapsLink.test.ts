import { describe, expect, it, vi } from 'vitest'
import type { PlaceDetails } from '../googlePlacesClient'
import { MapsLinkError, resolveMapsLink, type ResolveMapsLinkDeps } from '../resolveMapsLink'

const AQUARIUM_CID = BigInt('0xb5a84a1997229b63').toString()
const MONTEREY_URL = 'https://www.google.com/maps/place/Monterey+Bay+Aquarium,+Cannery+Row,+Monterey,+CA/@37.7767135,-122.4353989,15z/data=!4m5!3m4!1s0x808de6aa8166e4e3:0xb5a84a1997229b63!8m2!3d36.6182622!4d-121.9019542?entry=ttu'

const details = (over: Partial<PlaceDetails>): PlaceDetails => ({
  placeId: 'ChIJ-default',
  name: 'Default',
  lat: 0,
  lng: 0,
  categories: [],
  ...over,
})

const aquarium = details({
  placeId: 'ChIJaquarium',
  name: 'Monterey Bay Aquarium',
  lat: 36.6181,
  lng: -121.9017,
  address: '886 Cannery Row, Monterey, CA 93940',
  googleMapsUrl: `https://maps.google.com/?cid=${AQUARIUM_CID}`,
  website: 'https://www.montereybayaquarium.org/',
  categories: ['aquarium'],
})

const deps = (over: Partial<NonNullable<ResolveMapsLinkDeps['client']>> = {}): ResolveMapsLinkDeps => ({
  client: {
    getDetails: vi.fn(async () => { throw new Error('unexpected getDetails') }),
    searchText: vi.fn(async () => []),
    ...over,
  },
  expandShortLink: vi.fn(async () => { throw new Error('unexpected expandShortLink') }),
})

describe('resolveMapsLink', () => {
  it('finds the Google POI a place link names, biased to where the link says it is', async () => {
    const searchText = vi.fn(async () => [
      // Another POI in the same building — ranked first and near enough
      // to pass the distance check; only the CID tells them apart.
      details({placeId: 'ChIJother', name: 'Monterey Bay Aquarium Store', lat: 36.6183, lng: -121.902,
        googleMapsUrl: 'https://maps.google.com/?cid=1'}),
      aquarium,
    ])

    const candidate = await resolveMapsLink(MONTEREY_URL, deps({searchText}))

    expect(searchText).toHaveBeenCalledWith('Monterey Bay Aquarium, Cannery Row, Monterey, CA', {
      bias: expect.objectContaining({lat: 36.6182622, lng: -121.9019542}),
    })
    expect(candidate).toEqual({
      name: 'Monterey Bay Aquarium',
      lat: 36.6181,
      lng: -121.9017,
      address: '886 Cannery Row, Monterey, CA 93940',
      googlePlaceId: 'ChIJaquarium',
      googleMapsUrl: `https://maps.google.com/?cid=${AQUARIUM_CID}`,
      website: 'https://www.montereybayaquarium.org/',
      phone: undefined,
      categories: ['aquarium'],
    })
  })

  it('without a CID, takes the first search result near the linked coordinates', async () => {
    const url = 'https://www.google.com/maps/place/Blue+Bottle/data=!3d37.7765!4d-122.4233'
    const searchText = vi.fn(async () => [
      details({placeId: 'ChIJfar', name: 'Blue Bottle', lat: 37.8, lng: -122.3}),
      details({placeId: 'ChIJnear', name: 'Blue Bottle', lat: 37.7766, lng: -122.4232}),
    ])

    const candidate = await resolveMapsLink(url, deps({searchText}))

    expect(candidate.googlePlaceId).toBe('ChIJnear')
  })

  it('expands a short link before reading it', async () => {
    const d = deps({searchText: vi.fn(async () => [aquarium])})
    d.expandShortLink = vi.fn(async () => MONTEREY_URL)

    const candidate = await resolveMapsLink('https://maps.app.goo.gl/abc', d)

    expect(d.expandShortLink).toHaveBeenCalledWith('https://maps.app.goo.gl/abc')
    expect(candidate.googlePlaceId).toBe('ChIJaquarium')
  })

  it('fetches details directly when the link carries a place id', async () => {
    const getDetails = vi.fn(async () => aquarium)
    const url = 'https://www.google.com/maps/search/?api=1&query=Aquarium&query_place_id=ChIJaquarium'

    const candidate = await resolveMapsLink(url, deps({getDetails}))

    expect(getDetails).toHaveBeenCalledWith('ChIJaquarium', {})
    expect(candidate.googlePlaceId).toBe('ChIJaquarium')
  })

  it('falls back to what the link itself says when Google has no match', async () => {
    const searchText = vi.fn(async () => [
      details({placeId: 'ChIJfar', name: 'Monterey Bay Aquarium', lat: 40, lng: -100}),
    ])

    const candidate = await resolveMapsLink(MONTEREY_URL, deps({searchText}))

    expect(candidate).toEqual({
      name: 'Monterey Bay Aquarium',
      // The place's own coords, not the map centre (`@37.77,-122.43`).
      lat: 36.6182622,
      lng: -121.9019542,
      googleMapsUrl: `https://maps.google.com/?cid=${AQUARIUM_CID}`,
    })
  })

  it('falls back to the link without an API key', async () => {
    const candidate = await resolveMapsLink(MONTEREY_URL, {
      client: null,
      expandShortLink: vi.fn(),
    })
    expect(candidate).toMatchObject({name: 'Monterey Bay Aquarium', lat: 36.6182622, lng: -121.9019542})
    expect(candidate.googlePlaceId).toBeUndefined()
  })

  it('refuses a link that names no findable place and carries no position', async () => {
    await expect(resolveMapsLink('https://www.google.com/maps/@37.7,-122.4,15z', deps()))
      .rejects.toBeInstanceOf(MapsLinkError)
    await expect(resolveMapsLink('https://example.com/place', deps()))
      .rejects.toBeInstanceOf(MapsLinkError)
  })
})
