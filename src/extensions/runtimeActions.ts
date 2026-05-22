import { FacetRuntime } from '@/extensions/facet.js'
import { getEffectiveActions } from '@/shortcuts/effectiveActions.js'
import { ActionConfig } from '@/shortcuts/types.js'

export const readRuntimeActions = (
  runtime: FacetRuntime,
): readonly ActionConfig[] => getEffectiveActions(runtime)
