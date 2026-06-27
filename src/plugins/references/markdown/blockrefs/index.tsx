import { ReactNode } from 'react'
import type { Components } from 'react-markdown'
import type { MarkdownExtension } from '@/markdown/extensions.js'
import { remarkBlockrefs } from './remark-blockrefs.ts'
import { BlockRef } from '@/components/references/BlockRef.js'
import { BlockEmbed } from '@/components/references/BlockEmbed.js'

interface BlockrefNode {
  properties?: {
    blockId?: unknown
    aliased?: unknown
    occurrenceId?: unknown
  }
}

interface BlockrefComponentProps {
  node?: BlockrefNode
  children?: ReactNode
}

const getBlockId = (node?: BlockrefNode) => {
  const id = node?.properties?.blockId
  return typeof id === 'string' ? id : ''
}

const getOccurrenceId = (node?: BlockrefNode) => {
  const occurrenceId = node?.properties?.occurrenceId
  return typeof occurrenceId === 'string' && occurrenceId ? occurrenceId : 'unknown'
}

const isAliased = (node?: BlockrefNode) => node?.properties?.aliased === true

export const blockrefMarkdownExtension: MarkdownExtension = ({block}) => ({
  remarkPlugins: [remarkBlockrefs],
  components: {
    blockref: ({node, children}: BlockrefComponentProps) => {
      const blockId = getBlockId(node)
      if (!blockId) return null
      return (
        <BlockRef
          blockId={blockId}
          sourceBlockId={block.id}
          occurrenceId={getOccurrenceId(node)}
        >
          {isAliased(node) ? children : undefined}
        </BlockRef>
      )
    },
    blockembed: ({node}: BlockrefComponentProps) => {
      const blockId = getBlockId(node)
      if (!blockId) return null
      return (
        <BlockEmbed
          blockId={blockId}
          sourceBlockId={block.id}
          occurrenceId={getOccurrenceId(node)}
        />
      )
    },
  } as unknown as Components,
})
