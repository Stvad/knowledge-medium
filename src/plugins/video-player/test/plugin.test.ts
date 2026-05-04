import { describe, expect, it } from 'vitest'
import { propertySchemasFacet } from '@/data/facets.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { videoPlayerPlugin } from '../index.ts'
import { videoPlayerViewProp } from '../view.ts'

describe('videoPlayerPlugin', () => {
  it('contributes its player view schema', () => {
    const runtime = resolveFacetRuntimeSync(videoPlayerPlugin)
    const schemas = runtime.read(propertySchemasFacet)

    expect(schemas.get(videoPlayerViewProp.name)).toBe(videoPlayerViewProp)
  })
})
