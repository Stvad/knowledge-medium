import { BlockRendererProps } from '@/types.ts'
import Markdown from 'react-markdown'
import { useBlockContext } from '@/context/block.tsx'
import { useData } from '@/hooks/block.ts'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import { markdownExtensionsFacet } from '@/markdown/extensions.ts'

export function MarkdownContentRenderer({block}: BlockRendererProps) {
  const blockData = useData(block)
  const blockContext = useBlockContext()
  const runtime = useAppRuntime()

  if (!blockData) return null
  const resolveMarkdownConfig = runtime.read(markdownExtensionsFacet)
  const markdownConfig = resolveMarkdownConfig({block, blockContext})

  return (
    <div className="min-h-[1.7em] whitespace-pre-wrap overflow-x-hidden max-w-full">
      <Markdown
        remarkPlugins={markdownConfig.remarkPlugins}
        components={markdownConfig.components}
      >
        {blockData.content}
      </Markdown>
    </div>
  )
}
