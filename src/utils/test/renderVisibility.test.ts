import { describe, expect, it } from 'vitest'
import {
  areChildrenEffectivelyOpen,
  forceOpenScopeRootPolicy,
  getEffectiveChildrenVisibility,
  renderVisibilityPolicyForBlockContext,
} from '@/utils/renderVisibility.js'

describe('render visibility policy', () => {
  it('respects stored collapse when no override applies', () => {
    expect(areChildrenEffectivelyOpen(undefined, 'block', false)).toBe(true)
    expect(areChildrenEffectivelyOpen(undefined, 'block', true)).toBe(false)
  })

  it('force-opens a block without changing stored collapse', () => {
    expect(getEffectiveChildrenVisibility(
      {forceOpenBlockIds: ['block']},
      'block',
      true,
    )).toEqual({open: true, reason: 'force-open'})
  })

  it('lets force-closed win over force-open', () => {
    expect(getEffectiveChildrenVisibility(
      {forceOpenBlockIds: ['block'], forceClosedBlockIds: ['block']},
      'block',
      false,
    )).toEqual({open: false, reason: 'force-closed'})
  })

  it('defaults document surfaces to force-open the scope root', () => {
    expect(renderVisibilityPolicyForBlockContext({scopeRootId: 'root'}, 'root'))
      .toEqual(forceOpenScopeRootPolicy('root'))
  })

  it('does not force-open nested surfaces unless they opt in', () => {
    expect(renderVisibilityPolicyForBlockContext(
      {isNestedSurface: true, scopeRootId: 'root'},
      'root',
    )).toEqual({})
  })
})
