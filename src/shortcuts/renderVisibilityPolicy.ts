import type { BaseShortcutDependencies } from '@/shortcuts/types.js'
import type { RenderVisibilityPolicy } from '@/types.js'
import { renderVisibilityPolicyFromScopeRoot } from '@/utils/renderVisibility.js'

export const renderVisibilityPolicyForShortcutDeps = (
  deps: Pick<BaseShortcutDependencies, 'scopeRootId' | 'scopeRootForcesOpen' | 'renderVisibilityPolicy'>,
): RenderVisibilityPolicy =>
  deps.renderVisibilityPolicy ??
  renderVisibilityPolicyFromScopeRoot(deps.scopeRootId, deps.scopeRootForcesOpen)
