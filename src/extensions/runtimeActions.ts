import { actionsFacet } from '@/extensions/core.ts'
import { FacetRuntime } from '@/extensions/facet.ts'
import { ActionConfig } from '@/shortcuts/types.ts'

export const readRuntimeActions = (
  runtime: FacetRuntime,
): readonly ActionConfig[] => runtime.read(actionsFacet)
