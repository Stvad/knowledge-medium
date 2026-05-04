import { BlockRendererProps } from '@/types.ts'
import { MarkdownContentRenderer } from '@/components/renderer/MarkdownContentRenderer.tsx'
import { getBreadcrumbContentPreview } from '@/components/renderer/breadcrumbPreview.ts'

export const BreadcrumbRenderer = (props: BlockRendererProps) => (
  <MarkdownContentRenderer
    {...props}
    contentTransform={getBreadcrumbContentPreview}
    containerElement="span"
    containerClassName="inline min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap align-baseline [&>*]:inline [&>*]:m-0 [&>*]:font-normal [&>*]:text-inherit"
  />
)

BreadcrumbRenderer.canRender = ({context} : BlockRendererProps) => !!context?.isBreadcrumb
BreadcrumbRenderer.priority = () => 10
