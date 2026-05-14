import { FacetRuntime } from '@/extensions/facet.ts'
import { getEffectiveActions } from '@/shortcuts/effectiveActions.ts'
import { ActionConfig } from '@/shortcuts/types.ts'

export const readRuntimeActions = (
  runtime: FacetRuntime,
): readonly ActionConfig[] => getEffectiveActions(runtime)
