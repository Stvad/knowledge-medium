import { BlockRendererProps } from '@/types.ts'
import Markdown from 'react-markdown'
import { useBlockContext } from '@/context/block.tsx'
import { useData } from '@/hooks/block.ts'
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
  const blockData = useData(block)
  const blockContext = useBlockContext()
  const runtime = useAppRuntime()

  if (!blockData) return null
  const resolveMarkdownConfig = runtime.read(markdownExtensionsFacet)
  const markdownConfig = resolveMarkdownConfig({block, blockContext})
  const content = contentTransform ? contentTransform(blockData.content) : blockData.content

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
