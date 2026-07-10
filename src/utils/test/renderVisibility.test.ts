import { describe, expect, it } from 'vitest'
import {
  areChildrenEffectivelyOpen,
  EMPTY_RENDER_VISIBILITY_POLICY,
  getEffectiveChildrenVisibility,
} from '@/utils/renderVisibility.js'

describe('render visibility policy', () => {
  it('respects stored collapse when no override applies', () => {
    expect(areChildrenEffectivelyOpen(EMPTY_RENDER_VISIBILITY_POLICY, 'block', false)).toBe(true)
    expect(areChildrenEffectivelyOpen(EMPTY_RENDER_VISIBILITY_POLICY, 'block', true)).toBe(false)
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
})
