import { BlockRendererProps } from '@/types.ts'
import Markdown from 'react-markdown'
import { useBlockContext } from '@/context/block.tsx'
import { useData } from '@/hooks/block.ts'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import { markdownExtensionsFacet } from '@/markdown/extensions.ts'
import { getBreadcrumbContentPreview } from '@/components/renderer/breadcrumbPreview.ts'

export const BreadcrumbRenderer = ({block}: BlockRendererProps) => {
  const blockData = useData(block)
  const blockContext = useBlockContext()
  const runtime = useAppRuntime()

  if (!blockData) return null
  const resolveMarkdownConfig = runtime.read(markdownExtensionsFacet)
  const markdownConfig = resolveMarkdownConfig({block, blockContext})

  return (
    <span className="inline min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap align-baseline [&>*]:inline [&>*]:m-0 [&>*]:font-normal [&>*]:text-inherit">
      <Markdown
        remarkPlugins={markdownConfig.remarkPlugins}
        components={markdownConfig.components}
      >
        {getBreadcrumbContentPreview(blockData.content)}
      </Markdown>
    </span>
  )
}

BreadcrumbRenderer.canRender = ({context} : BlockRendererProps) => !!context?.isBreadcrumb
BreadcrumbRenderer.priority = () => 10
