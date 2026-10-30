import { ReactNode } from 'react'
import type { Components } from 'react-markdown'
import type { MarkdownExtension } from '@/markdown/extensions.js'
import { useMarkdownSource } from '@/markdown/source.js'
import { remarkWikilinks } from './remark-wikilinks.ts'
import { Wikilink } from './Wikilink.tsx'
import { EmbedComponent } from '../referenceNode.tsx'

interface WikilinkNode {
  properties?: {
    alias?: unknown
    blockId?: unknown
    hasCustomDisplay?: unknown
  }
}

interface WikilinkComponentProps {
  node?: WikilinkNode
  children?: ReactNode
}

const WikilinkComponent = ({node, children}: WikilinkComponentProps) => {
  const {block, workspaceId} = useMarkdownSource()
  const alias = node?.properties?.alias
  const blockId = node?.properties?.blockId
  if (typeof alias !== 'string') return null
  return (
    <Wikilink
      alias={alias}
      blockId={typeof blockId === 'string' ? blockId : ''}
      sourceBlock={block}
      workspaceId={workspaceId}
      hasCustomDisplay={node?.properties?.hasCustomDisplay === true}
    >
      {children}
    </Wikilink>
  )
}

const components = {
  wikilink: WikilinkComponent,
  pageembed: EmbedComponent,
} as unknown as Components

export const wikilinkMarkdownExtension: MarkdownExtension = ({data}) => {
  // Build the alias→id map from the reactive render `data`, NOT `block.peek()`:
  // the resolver is memoized (React Compiler) on the identity-stable `block`,
  // so a peek() read would freeze with whatever references existed at first
  // render and never pick up the async parse (link stays unresolved until a
  // remount). See MarkdownRenderContext.data.
  //
  // Block refs store alias === id (both the target UUID); page refs store the
  // human-typed alias separately from the resolved id. Filter to the latter
  // so a stray [[uuid]] wikilink can't silently resolve via a block-ref entry.
  const refMap = new Map(
    data.references
      .filter(ref => ref.alias !== ref.id)
      .map(({alias, id}) => [alias, id]),
  )

  return {
    remarkPlugins: [
      [remarkWikilinks, {resolveAlias: (alias: string) => refMap.get(alias)}],
    ],
    components,
  }
}
