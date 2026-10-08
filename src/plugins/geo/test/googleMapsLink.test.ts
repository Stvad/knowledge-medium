import { describe, expect, it } from 'vitest'
import { findGoogleMapsLinks, parseGoogleMapsUrl } from '../googleMapsLink'

const MONTEREY_URL = 'https://www.google.com/maps/place/Monterey+Bay+Aquarium,+Cannery+Row,+Monterey,+CA/@37.7767135,-122.4353989,15z/data=!4m5!3m4!1s0x808de6aa8166e4e3:0xb5a84a1997229b63!8m2!3d36.6182622!4d-121.9019542?entry=ttu&g_ep=EgoyMDI2MDkyMy4wIKXMDSoASAFQAw%3D%3D'

describe('parseGoogleMapsUrl', () => {
  it('reads the place name, its own coords, the map center, and the CID from a place URL', () => {
    expect(parseGoogleMapsUrl(MONTEREY_URL)).toEqual({
      kind: 'full',
      query: 'Monterey Bay Aquarium, Cannery Row, Monterey, CA',
      // `!3d…!4d…` is where the place is; `@…` is only where the map was
      // looking (here: San Francisco, 150km away).
      coords: {lat: 36.6182622, lng: -121.9019542},
      viewport: {lat: 37.7767135, lng: -122.4353989},
      cid: BigInt('0xb5a84a1997229b63').toString(),
    })
  })

  it('recognises short links without resolving them', () => {
    expect(parseGoogleMapsUrl('https://maps.app.goo.gl/kUHBzJWS8mqdFY2a8')).toEqual({kind: 'short'})
    expect(parseGoogleMapsUrl('https://goo.gl/maps/abcDEF123')).toEqual({kind: 'short'})
  })

  it('reads the Maps URLs API search form, place id included', () => {
    expect(parseGoogleMapsUrl(
      'https://www.google.com/maps/search/?api=1&query=Blue+Bottle+Coffee&query_place_id=ChIJabc123',
    )).toEqual({kind: 'full', query: 'Blue Bottle Coffee', placeId: 'ChIJabc123'})
  })

  it('reads the ?q=…&ftid=… form app shares use', () => {
    expect(parseGoogleMapsUrl(
      'https://maps.google.com/?q=Tartine+Bakery,+600+Guerrero+St&ftid=0x808f7e18a5b8a0d3:0x9a3f3c0d2c3b0a11',
    )).toEqual({
      kind: 'full',
      query: 'Tartine Bakery, 600 Guerrero St',
      cid: BigInt('0x9a3f3c0d2c3b0a11').toString(),
    })
  })

  it('reads coordinates written where a name would be as the place position', () => {
    expect(parseGoogleMapsUrl('https://www.google.com/maps?q=37.7609,-122.4216')).toEqual({
      kind: 'full',
      coords: {lat: 37.7609, lng: -122.4216},
    })
    expect(parseGoogleMapsUrl('https://www.google.com/maps/place/37.7609,-122.4216/@37.7609,-122.4216,17z')).toEqual({
      kind: 'full',
      coords: {lat: 37.7609, lng: -122.4216},
      viewport: {lat: 37.7609, lng: -122.4216},
    })
  })

  it('reads a place id given as q=place_id:…', () => {
    expect(parseGoogleMapsUrl('https://www.google.com/maps?q=place_id:ChIJxyz')).toEqual({
      kind: 'full',
      placeId: 'ChIJxyz',
    })
  })

  it('accepts country-code Google domains', () => {
    expect(parseGoogleMapsUrl('https://www.google.co.uk/maps/place/Big+Ben/@51.5007,-0.1246,17z')).toMatchObject({
      kind: 'full',
      query: 'Big Ben',
    })
  })

  it('drops out-of-range coordinates wherever they come from', () => {
    expect(parseGoogleMapsUrl('https://www.google.com/maps/place/X/data=!3d999!4d999')).toEqual({
      kind: 'full',
      query: 'X',
    })
  })

  it('rejects URLs that are not Google Maps', () => {
    expect(parseGoogleMapsUrl('https://www.google.com/search?q=maps')).toBeNull()
    expect(parseGoogleMapsUrl('https://goo.gl/abc')).toBeNull()
    expect(parseGoogleMapsUrl('https://example.com/maps/place/Foo')).toBeNull()
    expect(parseGoogleMapsUrl('https://google.com.evil.example/maps/place/Foo')).toBeNull()
    expect(parseGoogleMapsUrl('not a url')).toBeNull()
  })
})

describe('findGoogleMapsLinks', () => {
  it('finds bare links and trims sentence punctuation off the end', () => {
    const text = 'Lunch at https://maps.app.goo.gl/kUHBzJWS8mqdFY2a8. Then home.'
    const [link] = findGoogleMapsLinks(text)
    expect(link.url).toBe('https://maps.app.goo.gl/kUHBzJWS8mqdFY2a8')
    expect(text.slice(link.from, link.to)).toBe('https://maps.app.goo.gl/kUHBzJWS8mqdFY2a8')
  })

  it('spans the whole markdown link or autolink, so the replacement removes the wrapper too', () => {
    const text = `see [the aquarium](${MONTEREY_URL}) and <https://maps.app.goo.gl/abc>`
    const links = findGoogleMapsLinks(text)
    expect(links.map(l => l.url)).toEqual([MONTEREY_URL, 'https://maps.app.goo.gl/abc'])
    expect(links.map(l => text.slice(l.from, l.to))).toEqual([
      `[the aquarium](${MONTEREY_URL})`,
      '<https://maps.app.goo.gl/abc>',
    ])
  })

  it('keeps parentheses that are part of the URL, bare or in a markdown link', () => {
    const url = 'https://www.google.com/maps/place/Target+(CVS)/@37.7,-122.4,15z'
    const text = `(near ${url}) or [Target](${url})`
    expect(findGoogleMapsLinks(text).map(l => [l.url, text.slice(l.from, l.to)])).toEqual([
      [url, url],
      [url, `[Target](${url})`],
    ])
  })

  it('reads a markdown destination as its value: no angle brackets, no escapes', () => {
    const bracketed = '[map](<https://maps.app.goo.gl/abc>)'
    const escaped = '[map](https://www.google.com/maps/place/A\\(B\\)/@1,2,3z)'
    expect(findGoogleMapsLinks(bracketed)).toEqual([{from: 0, to: bracketed.length, url: 'https://maps.app.goo.gl/abc'}])
    expect(findGoogleMapsLinks(escaped)).toEqual([
      {from: 0, to: escaped.length, url: 'https://www.google.com/maps/place/A(B)/@1,2,3z'},
    ])
  })

  it('leaves links in code and images alone', () => {
    const text = [
      'inline `https://maps.app.goo.gl/inline` code',
      '```',
      'https://maps.app.goo.gl/fenced',
      '```',
      '![map](https://maps.app.goo.gl/image)',
    ].join('\n')
    expect(findGoogleMapsLinks(text)).toEqual([])
  })

  it('skips links to anything other than Google Maps', () => {
    expect(findGoogleMapsLinks('https://example.com and https://www.google.com/search?q=x')).toEqual([])
  })
})
