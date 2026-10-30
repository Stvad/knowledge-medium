import { ReactNode } from 'react'
import type { Components } from 'react-markdown'
import type { MarkdownExtension } from '@/markdown/extensions.js'
import { remarkWikilinks } from './remark-wikilinks.ts'
import { Wikilink } from './Wikilink.tsx'
import { BlockEmbed } from '@/components/references/BlockEmbed.js'
import { useRepo } from '@/context/repo.js'
import { referenceSourceOf, remarkReferenceSource } from '../referenceSource.ts'

interface WikilinkNode {
  properties?: {
    alias?: unknown
    blockId?: unknown
    hasCustomDisplay?: unknown
    occurrenceId?: unknown
  }
}

interface WikilinkComponentProps {
  node?: WikilinkNode
  children?: ReactNode
}

const remarkWikilinkSource = remarkReferenceSource(['wikilink', 'pageembed'])

const WikilinkComponent = ({node, children}: WikilinkComponentProps) => {
  const repo = useRepo()
  const alias = node?.properties?.alias
  const blockId = node?.properties?.blockId
  if (typeof alias !== 'string') return null
  const source = referenceSourceOf(node)
  return (
    <Wikilink
      alias={alias}
      blockId={typeof blockId === 'string' ? blockId : ''}
      sourceBlock={repo.block(source.sourceBlockId)}
      workspaceId={source.workspaceId}
      hasCustomDisplay={node?.properties?.hasCustomDisplay === true}
    >
      {children}
    </Wikilink>
  )
}

const PageEmbedComponent = ({node}: WikilinkComponentProps) => {
  const blockId = node?.properties?.blockId
  if (typeof blockId !== 'string' || !blockId) return null
  const occurrenceId = node?.properties?.occurrenceId
  return (
    <BlockEmbed
      blockId={blockId}
      sourceBlockId={referenceSourceOf(node).sourceBlockId}
      occurrenceId={typeof occurrenceId === 'string' && occurrenceId ? occurrenceId : 'unknown'}
    />
  )
}

const components = {
  wikilink: WikilinkComponent,
  pageembed: PageEmbedComponent,
} as unknown as Components

export const wikilinkMarkdownExtension: MarkdownExtension = ({block, data}) => {
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
      [remarkWikilinkSource, {sourceBlockId: block.id, workspaceId: data.workspaceId}],
    ],
    components,
  }
}
