import { describe, expect, it } from 'vitest'
import { blockHeaderFacet } from '@/extensions/blockInteraction.ts'
import { blockRenderersFacet } from '@/extensions/core.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import type { BlockResolveContext } from '@/extensions/blockInteraction.ts'
import {
  breadcrumbRendererContribution,
  breadcrumbsPlugin,
  BreadcrumbRenderer,
  Breadcrumbs,
} from '../index.ts'

const context = (isTopLevel: boolean) => ({
  isTopLevel,
}) as BlockResolveContext

describe('breadcrumbsPlugin', () => {
  it('contributes the breadcrumb renderer through blockRenderersFacet', () => {
    const runtime = resolveFacetRuntimeSync(breadcrumbsPlugin)

    expect(runtime.read(blockRenderersFacet).breadcrumb).toBe(BreadcrumbRenderer)
    expect(runtime.contributions(blockRenderersFacet).map(c => c.source)).toEqual(['breadcrumbs'])
    expect(runtime.contributions(blockRenderersFacet)[0].value).toBe(breadcrumbRendererContribution)
  })

  it('contributes top-level breadcrumbs through blockHeaderFacet only for top-level blocks', () => {
    const runtime = resolveFacetRuntimeSync(breadcrumbsPlugin)
    const resolveHeaders = runtime.read(blockHeaderFacet)

    expect(resolveHeaders(context(true))).toEqual([Breadcrumbs])
    expect(resolveHeaders(context(false))).toEqual([])
  })
})
