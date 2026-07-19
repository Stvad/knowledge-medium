import { describe, expect, it } from 'vitest'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { aliasesProp } from '@/data/properties'
import { definitionSeedsFacet, typeSeedsFacet } from '@/data/facets'
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
  const types = runtime.read(typeSeedsFacet)
  const seeds = runtime.read(definitionSeedsFacet)

  it('registers PLACE_TYPE with the place:* property list lifted', () => {
    const place = types.find(t => t.id === PLACE_TYPE)
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
    const page = types.find(t => t.id === MAP_TYPE)
    expect(page).toBeDefined()
    expect(page?.label).toBe('Map')
    expect(page?.properties?.map(p => p.name)).toEqual([aliasesProp.name])
  })

  it('registers every place:* property seed and locationProp', () => {
    const expected = [
      placeLatProp,
      placeLngProp,
      placeAddressProp,
      placeGooglePlaceIdProp,
      placeGoogleMapsUrlProp,
      placeWebsiteProp,
      placePhoneProp,
      placeCategoriesProp,
      locationProp,
    ]
    for (const declaration of expected) {
      expect(seeds, `missing seed ${declaration.name}`).toContain(declaration)
    }
  })
})
