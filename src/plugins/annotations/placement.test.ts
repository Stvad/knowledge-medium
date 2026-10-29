// @vitest-environment node
import {describe, expect, it} from 'vitest'
import {placeCards} from './placement'

const cards = (...pairs: Array<[anchor: number, height: number]>) => pairs.map(([anchor, height]) => ({anchor, height}))

describe('placeCards', () => {
  it('puts each card at its anchor while they do not overlap', () => {
    expect(placeCards(cards([0, 40], [100, 40], [300, 40]), null, 8)).toEqual([0, 100, 300])
  })

  it('pushes a card that would overlap the one above below it', () => {
    expect(placeCards(cards([0, 80], [20, 40], [30, 40]), null, 8)).toEqual([0, 88, 136])
  })

  it('pins the focused card to its anchor and pushes the cards above it up', () => {
    expect(placeCards(cards([0, 80], [20, 40], [30, 40]), 2, 8)).toEqual([-106, -18, 30])
  })

  it('keeps cards below the focused one pushed down from it', () => {
    expect(placeCards(cards([0, 40], [10, 100], [20, 40], [400, 10]), 1, 8)).toEqual([-38, 10, 118, 400])
  })

  it('places nothing for no cards', () => {
    expect(placeCards([], null, 8)).toEqual([])
  })
})
