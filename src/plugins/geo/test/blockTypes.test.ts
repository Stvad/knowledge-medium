import { describe, expect, it } from 'vitest'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { aliasesProp } from '@/data/internals/coreProperties'
import { propertySchemasFacet, typesFacet } from '@/data/facets'
import { MAP_TYPE, PLACE_TYPE } from '../blockTypes'
import {
  locationProp,
  placeAddressProp,
  placeCategoriesProp,
  placeGoogleMapsUrlProp,
  placeGooglePlaceIdProp,
  placeLatProp,
  placeLngProp,
  placePhoneProp,
  placeWebsiteProp,
} from '../properties'
import { geoDataExtension } from '../dataExtension'

describe('geoDataExtension types', () => {
  const runtime = resolveFacetRuntimeSync(geoDataExtension)
  const types = runtime.read(typesFacet)
  const schemas = runtime.read(propertySchemasFacet)

  it('registers PLACE_TYPE with the place:* property list lifted', () => {
    const place = types.get(PLACE_TYPE)
    expect(place).toBeDefined()
    expect(place?.label).toBe('Place')
    const propertyNames = (place?.properties ?? []).map(p => p.name).sort()
    expect(propertyNames).toEqual([
      placeAddressProp.name,
      placeCategoriesProp.name,
      placeGoogleMapsUrlProp.name,
      placeGooglePlaceIdProp.name,
      placeLatProp.name,
      placeLngProp.name,
      placePhoneProp.name,
      placeWebsiteProp.name,
    ].sort())
    // location is the *referencing* property, not a field of Place — it
    // must NOT be lifted onto the Place type.
    expect(propertyNames).not.toContain(locationProp.name)
  })

  it('registers MAP_TYPE with the user-facing label "Map" and aliasesProp lifted', () => {
    const page = types.get(MAP_TYPE)
    expect(page).toBeDefined()
    expect(page?.label).toBe('Map')
    expect(page?.properties?.map(p => p.name)).toEqual([aliasesProp.name])
  })

  it('registers every place:* schema and locationProp on propertySchemasFacet', () => {
    const expected = [
      placeLatProp.name,
      placeLngProp.name,
      placeAddressProp.name,
      placeGooglePlaceIdProp.name,
      placeGoogleMapsUrlProp.name,
      placeWebsiteProp.name,
      placePhoneProp.name,
      placeCategoriesProp.name,
      locationProp.name,
    ]
    for (const name of expected) {
      expect(schemas.has(name), `missing schema ${name}`).toBe(true)
    }
  })
})
