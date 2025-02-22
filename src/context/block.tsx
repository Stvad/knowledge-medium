import { createContext, useContext, useMemo, ReactNode } from 'react'
import { BlockContextType } from '@/types.ts'

export const BlockContext = createContext<BlockContextType>({})

export const BlockContextProvider = ({ children, initialValue}: { children: ReactNode, initialValue: BlockContextType }) => {
  return (
    <BlockContext value={initialValue}>
      {children}
    </BlockContext>
  )
}

export const NestedBlockContextProvider = (
  {children, overrides}: { children: ReactNode, overrides: Partial<BlockContextType> },
) => {
  const context = useContext(BlockContext)
  const value = useMemo(() =>
    ({...context, ...overrides}), [context, overrides])

  return (
    <BlockContext value={value}>
      {children}
    </BlockContext>
  )
}

export const useBlockContext = () => {
  const context = useContext(BlockContext)
  if (!context) {
    throw new Error('useBlockContext must be used within a BlockContextProvider')
  }
  return context
}

export const useUser = () => useBlockContext().user
