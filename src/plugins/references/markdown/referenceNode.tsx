import { BlockEmbed } from '@/components/references/BlockEmbed.js'
import { useMarkdownSource } from '@/markdown/source.js'

export interface ReferenceNode {
  properties?: {
    blockId?: unknown
    occurrenceId?: unknown
    aliased?: unknown
  }
}

/** The block a reference node points at and the occurrence it sits at; null
 *  for a reference that resolved to no block. */
export const referenceTargetOf = (node: ReferenceNode | undefined) => {
  const blockId = node?.properties?.blockId
  if (typeof blockId !== 'string' || !blockId) return null
  const occurrenceId = node?.properties?.occurrenceId
  return {blockId, occurrenceId: typeof occurrenceId === 'string' && occurrenceId ? occurrenceId : 'unknown'}
}

/** The `pageembed` and `blockembed` component. */
export const EmbedComponent = ({node}: {node?: ReferenceNode}) => {
  const {block} = useMarkdownSource()
  const target = referenceTargetOf(node)
  return target && <BlockEmbed {...target} sourceBlockId={block.id}/>
}
