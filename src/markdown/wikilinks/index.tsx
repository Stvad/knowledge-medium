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
  const data = block.peek()
  if (!data) return null

  // Block refs store alias === id (both the target UUID); page refs store the
  // human-typed alias separately from the resolved id. Filter to the latter
  // so a stray [[uuid]] wikilink can't silently resolve via a block-ref entry.
  const refMap = new Map(
    data.references
      .filter(ref => ref.alias !== ref.id)
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
