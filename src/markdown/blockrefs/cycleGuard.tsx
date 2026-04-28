import { createContext, ReactNode, useContext, useMemo } from 'react'

const BlockRefAncestors = createContext<ReadonlySet<string>>(new Set())

export const useBlockRefAncestors = () => useContext(BlockRefAncestors)

export const BlockRefAncestorsProvider = ({
  ancestor,
  children,
}: {
  ancestor: string
  children: ReactNode
}) => {
  const parent = useContext(BlockRefAncestors)
  const value = useMemo(() => {
    const next = new Set(parent)
    next.add(ancestor)
    return next
  }, [parent, ancestor])

  return <BlockRefAncestors value={value}>{children}</BlockRefAncestors>
}
