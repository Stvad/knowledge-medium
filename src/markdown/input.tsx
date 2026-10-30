import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { MarkdownInput } from './extensions.js'

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
