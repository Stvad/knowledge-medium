import type { RenderVisibilityPolicy } from '@/types.js'

export interface EffectiveChildrenVisibility {
  open: boolean
  reason: 'stored' | 'force-open' | 'force-closed'
}

export const EMPTY_RENDER_VISIBILITY_POLICY: RenderVisibilityPolicy = Object.freeze({})

const includesId = (ids: readonly string[] | undefined, blockId: string): boolean =>
  ids?.includes(blockId) ?? false

export const forceOpenScopeRootPolicy = (
  scopeRootId: string,
): RenderVisibilityPolicy => ({forceOpenBlockIds: [scopeRootId]})

export const getEffectiveChildrenVisibility = (
  policy: RenderVisibilityPolicy,
  blockId: string,
  storedCollapsed: boolean,
): EffectiveChildrenVisibility => {
  if (includesId(policy.forceClosedBlockIds, blockId)) {
    return {open: false, reason: 'force-closed'}
  }
  if (includesId(policy.forceOpenBlockIds, blockId)) {
    return {open: true, reason: 'force-open'}
  }
  return {open: !storedCollapsed, reason: 'stored'}
}

export const areChildrenEffectivelyOpen = (
  policy: RenderVisibilityPolicy,
  blockId: string,
  storedCollapsed: boolean,
): boolean =>
  getEffectiveChildrenVisibility(policy, blockId, storedCollapsed).open
