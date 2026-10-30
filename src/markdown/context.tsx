import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { Block } from '@/data/block.js'
import type { MarkdownInput } from './extensions.js'

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

const NO_INPUT: MarkdownInput = Object.freeze({})

const MarkdownInputContext = createContext<MarkdownInput>(NO_INPUT)

/** Provides `value` under `name` on `MarkdownRenderContext.input` of the
 *  markdown rendered below, embeds' included, alongside what providers above
 *  set. A new `value` re-resolves all of that markdown, so keep it stable. */
export const MarkdownInputProvider = ({name, value, children}: {
  name: string
  value: unknown
  children: ReactNode
}) => {
  const parent = useContext(MarkdownInputContext)
  const input = useMemo(() => ({...parent, [name]: value}), [parent, name, value])
  return <MarkdownInputContext value={input}>{children}</MarkdownInputContext>
}

export const useMarkdownInput = (): MarkdownInput => useContext(MarkdownInputContext)
