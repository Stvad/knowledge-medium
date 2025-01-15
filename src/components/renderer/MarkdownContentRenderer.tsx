import { BlockRendererProps } from '@/types.ts'
import { useIsEditing } from '@/data/properties.ts'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export function MarkdownContentRenderer({block}: BlockRendererProps) {
  const blockData = block.use()
  const [_, setIsEditing] = useIsEditing(block)

  if (!blockData) return null

  return (
    <div
      className="min-h-[1.7em] whitespace-pre-wrap"
      onClick={() => setIsEditing(true)}
    >
      <Markdown remarkPlugins={[remarkGfm]}>
        {blockData.content}
      </Markdown>
    </div>
  )
}
