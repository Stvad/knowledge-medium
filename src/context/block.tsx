import { createContext, useContext, useMemo, ReactNode } from 'react'
import { BlockContextType } from '@/types.ts'


export const BlockContext = createContext<BlockContextType>({})

export const NestedBlockContextProvider = (
  {children, overrides}: { children: ReactNode, overrides: Partial<BlockContextType> },
) => {
  const context = useContext(BlockContext)
  const value = useMemo(() =>
    ({...context, ...overrides}), [context, overrides])

  return (
    <BlockContext.Provider value={value}>
      {children}
    </BlockContext.Provider>
  )
}
