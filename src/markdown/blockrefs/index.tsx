import { ReactNode } from 'react'
import type { Components } from 'react-markdown'
import type { MarkdownExtension } from '@/markdown/extensions.ts'
import { remarkBlockrefs } from './remark-blockrefs.ts'
import { BlockRef } from './BlockRef.tsx'
import { BlockEmbed } from './BlockEmbed.tsx'

interface BlockrefNode {
  properties?: {
    blockId?: unknown
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

export const blockrefMarkdownExtension: MarkdownExtension = () => ({
  remarkPlugins: [remarkBlockrefs],
  components: {
    blockref: ({node}: BlockrefComponentProps) => {
      const blockId = getBlockId(node)
      if (!blockId) return null
      return <BlockRef blockId={blockId}/>
    },
    blockembed: ({node}: BlockrefComponentProps) => {
      const blockId = getBlockId(node)
      if (!blockId) return null
      return <BlockEmbed blockId={blockId}/>
    },
  } as unknown as Components,
})
