import { describe, expect, it } from 'vitest'
import { blockHeaderFacet } from '@/extensions/blockInteraction.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import type { BlockResolveContext } from '@/extensions/blockInteraction.js'
import { breadcrumbsPlugin, Breadcrumbs } from '../index.ts'

const context = (isTopLevel: boolean) => ({
  isTopLevel,
}) as BlockResolveContext

describe('breadcrumbsPlugin', () => {
  it('contributes top-level breadcrumbs through blockHeaderFacet only for top-level blocks', () => {
    const runtime = resolveFacetRuntimeSync(breadcrumbsPlugin)
    const resolveHeaders = runtime.read(blockHeaderFacet)

    expect(resolveHeaders(context(true))).toEqual([Breadcrumbs])
    expect(resolveHeaders(context(false))).toEqual([])
  })
})
