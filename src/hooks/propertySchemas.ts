import { type AnyPropertySchema } from '@/data/api'
import { useRepo } from '@/context/repo.tsx'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'

export const usePropertySchemas = (): ReadonlyMap<string, AnyPropertySchema> => {
  // Subscribe to runtime identity changes; Repo itself is stable across
  // setFacetRuntime swaps, but its merged schema registry is replaced.
  useAppRuntime()
  return useRepo().propertySchemas
}

