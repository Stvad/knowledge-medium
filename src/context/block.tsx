import { createContext, useContext, useMemo, ReactNode, useState } from 'react'
import { BlockContextType } from '@/types.ts'

export const BlockContext = createContext<BlockContextType>({})

export const BlockContextProvider = ({ children, initialValue}: { children: ReactNode, initialValue: BlockContextType }) => {
  const [focusedBlockId, setFocusedBlockId] = useState<string>()
  const [selection, setSelection] = useState<BlockContextType['selection']>()

  const value = useMemo(() => ({
    focusedBlockId,
    setFocusedBlockId,
    selection,
    setSelection,
    ...initialValue,
  }), [focusedBlockId, selection, initialValue])

  return (
    <BlockContext.Provider value={value}>
      {children}
    </BlockContext.Provider>
  )
}

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

export const useBlockContext = () => {
  const context = useContext(BlockContext)
  if (!context) {
    throw new Error('useBlockContext must be used within a BlockContextProvider')
  }
  return context
}
