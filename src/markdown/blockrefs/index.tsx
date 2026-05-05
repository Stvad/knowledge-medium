import { ReactNode } from 'react'
import type { Components } from 'react-markdown'
import type { MarkdownExtension } from '@/markdown/extensions.ts'
import { remarkBlockrefs } from './remark-blockrefs.ts'
import { BlockRef } from './BlockRef.tsx'
import { BlockEmbed } from './BlockEmbed.tsx'

interface BlockrefNode {
  properties?: {
    blockId?: unknown
    aliased?: unknown
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

const isAliased = (node?: BlockrefNode) => node?.properties?.aliased === true

export const blockrefMarkdownExtension: MarkdownExtension = () => ({
  remarkPlugins: [remarkBlockrefs],
  components: {
    blockref: ({node, children}: BlockrefComponentProps) => {
      const blockId = getBlockId(node)
      if (!blockId) return null
      return <BlockRef blockId={blockId}>{isAliased(node) ? children : undefined}</BlockRef>
    },
    blockembed: ({node}: BlockrefComponentProps) => {
      const blockId = getBlockId(node)
      if (!blockId) return null
      return <BlockEmbed blockId={blockId}/>
    },
  } as unknown as Components,
})
