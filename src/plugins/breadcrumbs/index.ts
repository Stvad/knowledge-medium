import { blockHeaderFacet } from '@/extensions/blockInteraction.ts'
import { blockRenderersFacet, type RendererContribution } from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { withSystemExtensionMetadata } from '@/extensions/togglable.ts'
import { Breadcrumbs } from './Breadcrumbs.tsx'
import { BreadcrumbRenderer } from './BreadcrumbRenderer.tsx'

export { BreadcrumbList } from './BreadcrumbList.tsx'
export { BreadcrumbRenderer } from './BreadcrumbRenderer.tsx'
export { Breadcrumbs } from './Breadcrumbs.tsx'
export { getBreadcrumbContentPreview } from './breadcrumbPreview.ts'

export const breadcrumbRendererContribution: RendererContribution = {
  id: 'breadcrumb',
  renderer: BreadcrumbRenderer,
}

export const breadcrumbsPlugin: AppExtension = withSystemExtensionMetadata({
  name: 'Breadcrumbs',
  description: 'Ancestor chain rendered above each panel.',
}, [
  blockRenderersFacet.of(breadcrumbRendererContribution, {source: 'breadcrumbs'}),
  // Header section: top-level breadcrumbs. Self-gates on isTopLevel so
  // non-top-level blocks pay no header cost.
  blockHeaderFacet.of(
    ctx => ctx.isTopLevel ? Breadcrumbs : null,
    {source: 'breadcrumbs'},
  ),
])
