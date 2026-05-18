import { describe, expect, it } from 'vitest'
import {
  pickVisualNavigationTarget,
  type VisualNavigationCandidate,
} from '@/utils/visualNavigation.ts'

const target = (
  id: string,
  rect: {top: number; left: number; width?: number; height?: number},
  order: number,
  surface: VisualNavigationCandidate['surface'] = 'document',
): VisualNavigationCandidate => ({
  id,
  blockId: id,
  surface,
  rect: {
    top: rect.top,
    left: rect.left,
    right: rect.left + (rect.width ?? 100),
    bottom: rect.top + (rect.height ?? 24),
  },
  order,
})

describe('visual navigation target picking', () => {
  it('moves down to a backlink occurrence when it is visually below the source', () => {
    const current = target('current', {top: 0, left: 0}, 0)
    const backlink = target('backlink', {top: 120, left: 0}, 1, 'backlink')
    const unrelatedRightPanel = target('right', {top: 0, left: 260}, 2)

    expect(pickVisualNavigationTarget(
      current,
      [current, backlink, unrelatedRightPanel],
      'down',
    )).toBe(backlink)
  })

  it('uses cross-axis overlap to pick the visually adjacent right-panel block', () => {
    const current = target('current', {top: 200, left: 0}, 0)
    const aligned = target('aligned', {top: 205, left: 280}, 1)
    const closerButMisaligned = target('misaligned', {top: 20, left: 240}, 2)

    expect(pickVisualNavigationTarget(
      current,
      [current, aligned, closerButMisaligned],
      'right',
    )).toBe(aligned)
  })

  it('ignores breadcrumb targets', () => {
    const current = target('current', {top: 0, left: 0}, 0)
    const breadcrumb = target('breadcrumb', {top: 40, left: 0}, 1, 'breadcrumb')
    const block = target('block', {top: 80, left: 0}, 2)

    expect(pickVisualNavigationTarget(
      current,
      [current, breadcrumb, block],
      'down',
    )).toBe(block)
  })
})
