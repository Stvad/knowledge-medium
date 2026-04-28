import type { Components } from 'react-markdown'
import type { MarkdownExtension } from '@/markdown/extensions.ts'
import { remarkWikilinks } from './remark-wikilinks.ts'
import { Wikilink } from './Wikilink.tsx'

interface WikilinkNode {
  properties?: {
    alias?: unknown
  }
}

interface WikilinkComponentProps {
  node?: WikilinkNode
}

export const wikilinkMarkdownExtension: MarkdownExtension = () => ({
  remarkPlugins: [remarkWikilinks],
  components: {
    wikilink: ({node}: WikilinkComponentProps) => {
      const alias = node?.properties?.alias
      if (typeof alias !== 'string') return null
      return <Wikilink alias={alias}/>
    },
  } as unknown as Components,
})
