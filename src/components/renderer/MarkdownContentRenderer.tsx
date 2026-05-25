import { BlockRendererProps } from '@/types.js'
import Markdown from 'react-markdown'
import { useBlockContext } from '@/context/block.js'
import { useHandle } from '@/hooks/block.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { markdownExtensionsFacet } from '@/markdown/extensions.js'

const DEFAULT_CONTAINER_CLASS = 'min-h-[1.7em] whitespace-pre-wrap overflow-x-clip overflow-y-visible max-w-full'

interface MarkdownContentRendererProps extends BlockRendererProps {
  contentTransform?: (content: string) => string
  containerClassName?: string
  containerElement?: 'div' | 'span'
}

export function MarkdownContentRenderer({
  block,
  contentTransform,
  containerClassName = DEFAULT_CONTAINER_CLASS,
  containerElement: Container = 'div',
}: MarkdownContentRendererProps) {
  const renderData = useHandle(block, {
    selector: doc => doc
      ? {
        content: doc.content,
        references: doc.references,
        workspaceId: doc.workspaceId,
      }
      : undefined,
  })
  const blockContext = useBlockContext()
  const runtime = useAppRuntime()

  if (!renderData) return null
  const resolveMarkdownConfig = runtime.read(markdownExtensionsFacet)
  const markdownConfig = resolveMarkdownConfig({block, blockContext})
  const content = contentTransform ? contentTransform(renderData.content) : renderData.content

  return (
    <Container className={containerClassName}>
      <Markdown
        remarkPlugins={markdownConfig.remarkPlugins}
        components={markdownConfig.components}
      >
        {content}
      </Markdown>
    </Container>
  )
}
