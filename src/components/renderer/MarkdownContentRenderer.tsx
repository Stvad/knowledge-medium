import { BlockRendererProps } from '@/types.ts'
import Markdown from 'react-markdown'
import { useBlockContext } from '@/context/block.tsx'
import { useHandle } from '@/hooks/block.ts'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import { markdownExtensionsFacet } from '@/markdown/extensions.ts'

const DEFAULT_CONTAINER_CLASS = 'min-h-[1.7em] whitespace-pre-wrap overflow-x-hidden max-w-full'

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
