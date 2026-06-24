import { createContext, useContext } from 'react'
import { FacetRuntime } from '@/facets/facet.js'

const AppRuntimeContext = createContext<FacetRuntime | undefined>(undefined)

export const AppRuntimeContextProvider = AppRuntimeContext

export function useAppRuntime(): FacetRuntime {
  const runtime = useContext(AppRuntimeContext)
  if (!runtime) {
    throw new Error('useAppRuntime must be used within an AppRuntimeProvider')
  }
  return runtime
}
