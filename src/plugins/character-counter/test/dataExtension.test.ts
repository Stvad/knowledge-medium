import { describe, expect, it } from 'vitest'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { propertySchemasFacet, typesFacet } from '@/data/facets'
import { CHAR_COUNTER_TYPE } from '../blockType'
import { charLimitProp } from '../properties'
import { characterCounterDataExtension } from '../dataExtension'

describe('characterCounterDataExtension', () => {
  const runtime = resolveFacetRuntimeSync(characterCounterDataExtension)
  const types = runtime.read(typesFacet)
  const schemas = runtime.read(propertySchemasFacet)

  it('registers the char-counter type with char:limit lifted', () => {
    const type = types.get(CHAR_COUNTER_TYPE)
    expect(type).toBeDefined()
    expect(type?.label).toBe('Character counter')
    expect(type?.properties?.map(p => p.name)).toEqual([charLimitProp.name])
  })

  it('registers the char:limit schema on propertySchemasFacet', () => {
    expect(schemas.has(charLimitProp.name)).toBe(true)
  })
})
