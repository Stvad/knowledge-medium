import { BlockRendererProps } from '@/types.ts'
import { MarkdownContentRenderer } from '@/components/renderer/MarkdownContentRenderer.tsx'

export const BreadcrumbRenderer = (props: BlockRendererProps) => <MarkdownContentRenderer {...props}/>

BreadcrumbRenderer.canRender = ({context} : BlockRendererProps) => !!context?.isBreadcrumb
BreadcrumbRenderer.priority = () => 5
