import type { BlockContextType, RenderVisibilityPolicy } from '@/types.js'

export interface EffectiveChildrenVisibility {
  open: boolean
  reason: 'stored' | 'force-open' | 'force-closed'
}

export const EMPTY_RENDER_VISIBILITY_POLICY: RenderVisibilityPolicy = Object.freeze({})

const includesId = (ids: readonly string[] | undefined, blockId: string): boolean =>
  ids?.includes(blockId) ?? false

export const hasRenderVisibilityPolicy = (
  policy: RenderVisibilityPolicy | undefined,
): boolean =>
  Boolean(policy?.forceOpenBlockIds?.length || policy?.forceClosedBlockIds?.length)

export const renderVisibilityPolicyFromContext = (
  context: BlockContextType | undefined,
): RenderVisibilityPolicy => {
  if (!context?.forceOpenBlockIds?.length && !context?.forceClosedBlockIds?.length) {
    return EMPTY_RENDER_VISIBILITY_POLICY
  }
  return {
    ...(context.forceOpenBlockIds?.length
      ? {forceOpenBlockIds: context.forceOpenBlockIds}
      : {}),
    ...(context.forceClosedBlockIds?.length
      ? {forceClosedBlockIds: context.forceClosedBlockIds}
      : {}),
  }
}

export const forceOpenScopeRootPolicy = (
  scopeRootId: string | undefined,
): RenderVisibilityPolicy =>
  scopeRootId ? {forceOpenBlockIds: [scopeRootId]} : EMPTY_RENDER_VISIBILITY_POLICY

export const renderVisibilityPolicyFromScopeRoot = (
  scopeRootId: string | undefined,
  scopeRootForcesOpen = true,
): RenderVisibilityPolicy =>
  scopeRootForcesOpen
    ? forceOpenScopeRootPolicy(scopeRootId)
    : EMPTY_RENDER_VISIBILITY_POLICY

/** Visibility policy for a surface. Explicit context overrides win; the
 *  historical document-surface default force-opens its scope root, while
 *  nested surfaces only force-open when they say so explicitly. */
export const renderVisibilityPolicyForBlockContext = (
  context: BlockContextType | undefined,
  scopeRootId: string | undefined,
): RenderVisibilityPolicy => {
  const explicit = renderVisibilityPolicyFromContext(context)
  if (hasRenderVisibilityPolicy(explicit)) return explicit
  return context?.isNestedSurface
    ? EMPTY_RENDER_VISIBILITY_POLICY
    : forceOpenScopeRootPolicy(scopeRootId)
}

export const getEffectiveChildrenVisibility = (
  policy: RenderVisibilityPolicy | undefined,
  blockId: string,
  storedCollapsed: boolean,
): EffectiveChildrenVisibility => {
  if (includesId(policy?.forceClosedBlockIds, blockId)) {
    return {open: false, reason: 'force-closed'}
  }
  if (includesId(policy?.forceOpenBlockIds, blockId)) {
    return {open: true, reason: 'force-open'}
  }
  return {open: !storedCollapsed, reason: 'stored'}
}

export const areChildrenEffectivelyOpen = (
  policy: RenderVisibilityPolicy | undefined,
  blockId: string,
  storedCollapsed: boolean,
): boolean =>
  getEffectiveChildrenVisibility(policy, blockId, storedCollapsed).open

export const isBlockForceOpened = (
  policy: RenderVisibilityPolicy | undefined,
  blockId: string | undefined,
): boolean =>
  Boolean(blockId && includesId(policy?.forceOpenBlockIds, blockId))
