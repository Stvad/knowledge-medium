import { blockHeaderFacet, blockRendererFacet } from '@/extensions/blockInteraction.js'
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { Breadcrumbs } from './Breadcrumbs.tsx'
import { breadcrumbRendererRegistration } from './BreadcrumbRenderer.tsx'

export { BreadcrumbList } from './BreadcrumbList.tsx'
export { PromotableBreadcrumbList } from './PromotableBreadcrumbList.tsx'
export { usePromotableBreadcrumb, type PromotableBreadcrumb } from './usePromotableBreadcrumb.ts'
export { BreadcrumbRenderer } from './BreadcrumbRenderer.tsx'
export { Breadcrumbs } from './Breadcrumbs.tsx'
export { getBreadcrumbContentPreview } from './breadcrumbPreview.ts'

export const breadcrumbsPlugin: AppExtension = systemToggle({
  id: 'system:breadcrumbs',
  name: 'Breadcrumbs',
  description: 'Ancestor chain rendered above each panel.',
}).of([
  blockRendererFacet.of(breadcrumbRendererRegistration, {source: 'breadcrumbs', precedence: 10}),
  // Header section: top-level breadcrumbs. Self-gates on isTopLevel so
  // non-top-level blocks pay no header cost.
  blockHeaderFacet.of(
    ctx => ctx.isTopLevel ? Breadcrumbs : null,
    {source: 'breadcrumbs'},
  ),
])
