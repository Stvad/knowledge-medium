import { describe, expect, it } from 'vitest'
import {
  pickVisualNavigationTarget,
  type VisualNavigationCandidate,
} from '@/plugins/visual-navigation/navigation.ts'

const target = (
  id: string,
  rect: {top: number; left: number; width?: number; height?: number},
  order: number,
  surface: VisualNavigationCandidate['surface'] = 'document',
  panelId?: string,
): VisualNavigationCandidate => ({
  id,
  blockId: id,
  panelId,
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
    const current = target('current', {top: 200, left: 0}, 0, 'document', 'left-panel')
    const aligned = target('aligned', {top: 205, left: 280}, 1, 'document', 'right-panel')
    const closerButMisaligned = target('misaligned', {top: 20, left: 240}, 2, 'document', 'right-panel')

    expect(pickVisualNavigationTarget(
      current,
      [current, aligned, closerButMisaligned],
      'right',
    )).toBe(aligned)
  })

  it('moves horizontally across panels instead of into an indented child', () => {
    const current = target('current', {top: 40, left: 0}, 0, 'document', 'left-panel')
    const indentedChild = target('child', {top: 70, left: 40}, 1, 'document', 'left-panel')
    const rightPanelBlock = target('right-panel-block', {top: 42, left: 280}, 2, 'document', 'right-panel')

    expect(pickVisualNavigationTarget(
      current,
      [current, indentedChild, rightPanelBlock],
      'right',
    )).toBe(rightPanelBlock)
  })

  it('keeps vertical movement in the current panel when possible', () => {
    const current = target('current', {top: 0, left: 0}, 0, 'document', 'left-panel')
    const samePanelBelow = target('same-panel-below', {top: 180, left: 0}, 1, 'document', 'left-panel')
    const rightPanelCloser = target('right-panel-closer', {top: 60, left: 280}, 2, 'document', 'right-panel')

    expect(pickVisualNavigationTarget(
      current,
      [current, samePanelBelow, rightPanelCloser],
      'down',
    )).toBe(samePanelBelow)
  })

  it('does not jump vertically into a horizontally offset panel', () => {
    const current = target('current', {top: 0, left: 0}, 0, 'document', 'left-panel')
    const rightPanelBelow = target('right-panel-below', {top: 80, left: 280}, 1, 'document', 'right-panel')

    expect(pickVisualNavigationTarget(
      current,
      [current, rightPanelBelow],
      'down',
    )).toBeNull()
  })

  it('allows vertical panel jumps when panels share a visual column', () => {
    const current = target('current', {top: 0, left: 0}, 0, 'document', 'top-panel')
    const stackedBelow = target('stacked-below', {top: 140, left: 0}, 1, 'document', 'bottom-panel')

    expect(pickVisualNavigationTarget(
      current,
      [current, stackedBelow],
      'down',
    )).toBe(stackedBelow)
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
