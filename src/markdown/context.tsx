import { createContext, useContext } from 'react'
import type { Block } from '@/data/block.js'

/** The block whose content the surrounding markdown renders, set by the
 *  markdown renderer around its output. A `components` override reads it here
 *  instead of closing over it (`MarkdownRenderConfig.components` says why). */
export interface MarkdownSource {
  block: Block
  workspaceId: string
}

export const MarkdownSourceContext = createContext<MarkdownSource | null>(null)

export const useMarkdownSource = (): MarkdownSource => {
  const source = useContext(MarkdownSourceContext)
  if (!source) throw new Error('useMarkdownSource must be used inside rendered markdown')
  return source
}
