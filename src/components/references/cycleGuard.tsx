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
