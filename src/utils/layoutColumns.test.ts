import {describe, expect, it} from 'vitest'
import {columnWeightHolder, equalizeColumnPair, resizeColumns} from './layoutColumns'

describe('resizeColumns', () => {
  it('moves width across the divider and leaves the other columns where they are', () => {
    expect(resizeColumns({widths: [600, 600, 600], divider: 1, dx: 150, minWidth: 384}))
      .toEqual([1.25, 0.75, 1])
  })

  it('weighs every column by its rendered width, a column held at the minimum included', () => {
    // Weights [0.5, 1, 1] in 1400px render [384, 508, 508]: the first track is
    // at the minimum, not at its weight's share.
    expect(resizeColumns({widths: [384, 508, 508], divider: 1, dx: 100, minWidth: 384}))
      .toEqual([1.037, 0.874, 1.089])
  })

  it('stops each column of the pair at the minimum', () => {
    expect(resizeColumns({widths: [600, 600], divider: 1, dx: 500, minWidth: 384})).toEqual([1.36, 0.64])
    expect(resizeColumns({widths: [600, 600], divider: 1, dx: -500, minWidth: 384})).toEqual([0.64, 1.36])
  })
})

describe('equalizeColumnPair', () => {
  it('splits the pair\'s weight evenly and leaves the rest', () => {
    expect(equalizeColumnPair([0.5, 1.5, 2], 1)).toEqual([1, 1, 2])
  })
})

describe('columnWeightHolder', () => {
  const panel = (id: string, weight?: number) => ({kind: 'panel' as const, id, weight})

  it('holds a panel column\'s width on the panel', () => {
    expect(columnWeightHolder(panel('a', 2))).toEqual({id: 'a', weight: 2})
    expect(columnWeightHolder(panel('a'))).toEqual({id: 'a', weight: 1})
  })

  it('holds a stack\'s width on its first panel with one, so a panel stacked in front leaves it', () => {
    expect(columnWeightHolder({kind: 'stack', children: [panel('n'), panel('b', 2)]})).toEqual({id: 'b', weight: 2})
  })

  it('puts a stack\'s first width on its first panel', () => {
    expect(columnWeightHolder({kind: 'stack', children: [panel('x'), panel('y')]})).toEqual({id: 'x', weight: 1})
    expect(columnWeightHolder({kind: 'stack', children: []})).toBeUndefined()
  })
})
