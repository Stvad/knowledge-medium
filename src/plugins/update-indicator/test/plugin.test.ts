import { describe, expect, it } from 'vitest'
import { propertySchemasFacet } from '@/data/facets.ts'
import { appEffectsFacet } from '@/extensions/core.ts'
import { blockContentDecoratorsFacet } from '@/extensions/blockInteraction.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import {
  currentLoadTimeProp,
  previousLoadTimeProp,
  updateIndicatorLoadTimeEffect,
} from '../loadTimes.ts'
import { updateIndicatorPlugin } from '../index.tsx'

describe('updateIndicatorPlugin', () => {
  it('contributes its load-time effect', () => {
    const runtime = resolveFacetRuntimeSync(updateIndicatorPlugin)

    expect(runtime.read(appEffectsFacet)).toEqual([updateIndicatorLoadTimeEffect])
  })

  it('contributes its property schemas', () => {
    const runtime = resolveFacetRuntimeSync(updateIndicatorPlugin)
    const schemas = runtime.read(propertySchemasFacet)

    expect(schemas.get(previousLoadTimeProp.name)).toBe(previousLoadTimeProp)
    expect(schemas.get(currentLoadTimeProp.name)).toBe(currentLoadTimeProp)
  })

  it('contributes its block content decorator', () => {
    const runtime = resolveFacetRuntimeSync(updateIndicatorPlugin)

    expect(runtime.contributions(blockContentDecoratorsFacet)).toHaveLength(1)
  })
})
