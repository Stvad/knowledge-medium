import { actionsFacet, actionContextsFacet } from '@/extensions/core.ts'
import { FacetRuntime } from '@/extensions/facet.ts'
import { vimNormalModeActionsFacet } from '@/shortcuts/vimNormalMode.ts'
import { ActionConfig, ActionContextConfig } from '@/shortcuts/types.ts'

export const readRuntimeActionContexts = (
  runtime: FacetRuntime,
): readonly ActionContextConfig[] => runtime.read(actionContextsFacet)

export const readRuntimeActions = (
  runtime: FacetRuntime,
): readonly ActionConfig[] => [
  ...runtime.read(actionsFacet),
  ...runtime.read(vimNormalModeActionsFacet) as readonly ActionConfig[],
]
