import {describe, expect, it} from 'vitest'
import {resizeColumnPair} from './layoutColumns'

describe('resizeColumnPair', () => {
  it('moves width from one column to its neighbour, keeping the pair\'s total weight', () => {
    expect(resizeColumnPair({widths: [600, 600], weights: [1, 1], dx: 150, minWidth: 384})).toEqual([1.25, 0.75])
  })

  it('reads the weights the pair already has', () => {
    expect(resizeColumnPair({widths: [800, 400], weights: [2, 1], dx: -200, minWidth: 384})).toEqual([1.5, 1.5])
  })

  it('stops each column at the minimum width', () => {
    expect(resizeColumnPair({widths: [600, 600], weights: [1, 1], dx: 500, minWidth: 384})).toEqual([1.36, 0.64])
    expect(resizeColumnPair({widths: [600, 600], weights: [1, 1], dx: -500, minWidth: 384})).toEqual([0.64, 1.36])
  })

  it('leaves a pair with no room above both minimums as it is', () => {
    expect(resizeColumnPair({widths: [384, 384], weights: [1, 3], dx: 50, minWidth: 384})).toEqual([1, 3])
  })
})
