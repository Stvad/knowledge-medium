import { ReactNode } from 'react'
import type { Components } from 'react-markdown'
import type { MarkdownExtension } from '@/markdown/extensions.ts'
import { remarkWikilinks } from './remark-wikilinks.ts'
import { Wikilink } from './Wikilink.tsx'
import { BlockEmbed } from '@/markdown/blockrefs/BlockEmbed.tsx'

interface WikilinkNode {
  properties?: {
    alias?: unknown
    blockId?: unknown
  }
}

interface WikilinkComponentProps {
  node?: WikilinkNode
  children?: ReactNode
}

export const wikilinkMarkdownExtension: MarkdownExtension = ({block}) => {
  const data = block.dataSync()
  if (!data) return null

  // `references` only stores page-kind entries by alias; block-kind entries
  // have alias === id which would silently shadow a real alias if both
  // appeared. Filter so the alias→id map is unambiguous.
  const refMap = new Map(
    data.references
      .filter(ref => ref.kind !== 'block')
      .map(({alias, id}) => [alias, id]),
  )
  const workspaceId = data.workspaceId

  return {
    remarkPlugins: [
      [remarkWikilinks, {resolveAlias: (alias: string) => refMap.get(alias)}],
    ],
    components: {
      wikilink: ({node, children}: WikilinkComponentProps) => {
        const alias = node?.properties?.alias
        const blockId = node?.properties?.blockId
        if (typeof alias !== 'string') return null
        return (
          <Wikilink
            alias={alias}
            blockId={typeof blockId === 'string' ? blockId : ''}
            workspaceId={workspaceId}
          >
            {children}
          </Wikilink>
        )
      },
      pageembed: ({node}: WikilinkComponentProps) => {
        const blockId = node?.properties?.blockId
        if (typeof blockId !== 'string' || !blockId) return null
        return <BlockEmbed blockId={blockId}/>
      },
    } as unknown as Components,
  }
}
