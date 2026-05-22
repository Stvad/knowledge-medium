import { describe, expect, it } from 'vitest'
import { appEffectsFacet } from '@/extensions/core.js'
import { resolveFacetRuntimeSync } from '@/extensions/facet.js'
import { appIntentsBootstrapEffect, appIntentsPlugin } from '../index.ts'

describe('appIntentsPlugin', () => {
  it('contributes its bootstrap effect', () => {
    const runtime = resolveFacetRuntimeSync(appIntentsPlugin)

    expect(runtime.read(appEffectsFacet)).toEqual([appIntentsBootstrapEffect])
  })
})
