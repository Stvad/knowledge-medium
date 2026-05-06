import { describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { propertySchemasFacet } from '@/data/facets.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { videoPlayerPlugin } from '../index.ts'
import { videoNotesPaneRatioProp, videoPlayerViewProp } from '../view.ts'

describe('videoPlayerPlugin', () => {
  it('contributes its player schemas', () => {
    const runtime = resolveFacetRuntimeSync(videoPlayerPlugin)
    const schemas = runtime.read(propertySchemasFacet)

    expect(schemas.get(videoPlayerViewProp.name)).toBe(videoPlayerViewProp)
    expect(schemas.get(videoNotesPaneRatioProp.name)).toBe(videoNotesPaneRatioProp)
    expect(videoNotesPaneRatioProp.changeScope).toBe(ChangeScope.UserPrefs)
  })
})
