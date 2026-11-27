import { type ReactNode, useContext, useMemo } from 'react'
import { BlockRefAncestorsContext } from './cycleGuardContext'

export const BlockRefAncestorsProvider = ({
  ancestor,
  children,
}: {
  ancestor: string
  children: ReactNode
}) => {
  const parent = useContext(BlockRefAncestorsContext)
  const value = useMemo(() => {
    const next = new Set(parent)
    next.add(ancestor)
    return next
  }, [parent, ancestor])

  return <BlockRefAncestorsContext value={value}>{children}</BlockRefAncestorsContext>
}

const NO_ANCESTORS: ReadonlySet<string> = new Set()

/** Starts a fresh ref chain, for a surface the user opens by hand (a link
 *  preview) rather than one the content renders on its own. */
export const BlockRefAncestorsRoot = ({children}: {children: ReactNode}) =>
  <BlockRefAncestorsContext value={NO_ANCESTORS}>{children}</BlockRefAncestorsContext>
