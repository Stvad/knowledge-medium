import { ReactNode } from 'react'
import type { Components } from 'react-markdown'
import type { MarkdownExtension } from '@/markdown/extensions.js'
import { useMarkdownSource } from '@/markdown/context.js'
import { remarkBlockrefs } from './remark-blockrefs.ts'
import { BlockRef } from '@/components/references/BlockRef.js'
import { EmbedComponent, referenceTargetOf, type ReferenceNode } from '../referenceNode.tsx'

interface BlockrefComponentProps {
  node?: ReferenceNode
  children?: ReactNode
}

const BlockrefComponent = ({node, children}: BlockrefComponentProps) => {
  const {block} = useMarkdownSource()
  const target = referenceTargetOf(node)
  if (!target) return null
  return (
    <BlockRef {...target} sourceBlockId={block.id}>
      {node?.properties?.aliased === true ? children : undefined}
    </BlockRef>
  )
}

const components = {
  blockref: BlockrefComponent,
  blockembed: EmbedComponent,
} as unknown as Components

export const blockrefMarkdownExtension: MarkdownExtension = () => ({
  remarkPlugins: [remarkBlockrefs],
  components,
})
