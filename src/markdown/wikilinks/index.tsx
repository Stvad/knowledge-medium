import type { Components } from 'react-markdown'
import type { MarkdownExtension } from '@/markdown/extensions.ts'
import { remarkWikilinks } from './remark-wikilinks.ts'
import { Wikilink } from './Wikilink.tsx'

interface WikilinkNode {
  properties?: {
    alias?: unknown
    blockId?: unknown
  }
}

interface WikilinkComponentProps {
  node?: WikilinkNode
}

export const wikilinkMarkdownExtension: MarkdownExtension = ({block}) => {
  const data = block.dataSync()
  if (!data) return null

  const refMap = new Map(data.references.map(({alias, id}) => [alias, id]))
  const workspaceId = data.workspaceId

  return {
    remarkPlugins: [
      [remarkWikilinks, {resolveAlias: (alias: string) => refMap.get(alias)}],
    ],
    components: {
      wikilink: ({node}: WikilinkComponentProps) => {
        const alias = node?.properties?.alias
        const blockId = node?.properties?.blockId
        if (typeof alias !== 'string') return null
        return (
          <Wikilink
            alias={alias}
            blockId={typeof blockId === 'string' ? blockId : ''}
            workspaceId={workspaceId}
          />
        )
      },
    } as unknown as Components,
  }
}
