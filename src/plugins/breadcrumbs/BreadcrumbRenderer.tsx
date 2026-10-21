import { BlockRendererProps } from '@/types.js'
import { MarkdownContentRenderer } from '@/components/renderer/MarkdownContentRenderer.js'
import { getBreadcrumbContentPreview } from './breadcrumbPreview.ts'
import type { BlockRendererRegistration } from '@/extensions/blockInteraction.js'

export const BreadcrumbRenderer = (props: BlockRendererProps) => (
  <MarkdownContentRenderer
    {...props}
    contentTransform={getBreadcrumbContentPreview}
    containerElement="span"
    containerClassName="inline min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap align-baseline [&>*]:inline [&>*]:m-0 [&>*]:font-normal [&>*]:text-inherit"
  />
)

export const breadcrumbRendererRegistration: BlockRendererRegistration = {
  id: 'breadcrumb',
  label: 'Breadcrumb',
  resolve: ctx => ctx.blockContext?.isBreadcrumb ? {render: BreadcrumbRenderer} : null,
}
