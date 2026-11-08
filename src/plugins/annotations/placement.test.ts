// @vitest-environment node
import {describe, expect, it} from 'vitest'
import {byPlacement, fitColumn, placeCards, type MarginCard} from './placement'

const cards = (...pairs: Array<[anchor: number, height: number]>) => pairs.map(([anchor, height]) => ({anchor, height}))

describe('placeCards', () => {
  it('puts each card at its anchor while they do not overlap', () => {
    expect(placeCards(cards([0, 40], [100, 40], [300, 40]), -1, 8, 1000)).toEqual([0, 100, 300])
  })

  it('pushes a card that would overlap the one above below it', () => {
    expect(placeCards(cards([0, 80], [20, 40], [30, 40]), -1, 8, 1000)).toEqual([0, 88, 136])
  })

  it('pins the focused card to its anchor and pushes the cards above it up', () => {
    expect(placeCards(cards([0, 80], [20, 40], [30, 40]), 2, 8, 1000)).toEqual([-106, -18, 30])
  })

  it('keeps cards below the focused one pushed down from it', () => {
    expect(placeCards(cards([0, 40], [10, 100], [20, 40], [400, 10]), 1, 8, 1000)).toEqual([-38, 10, 118, 400])
  })

  it('leaves the focused card unpinned while its row is out of view', () => {
    expect(placeCards(cards([0, 80], [20, 40], [1200, 40]), 2, 8, 1000)).toEqual([0, 88, 1200])
    expect(placeCards(cards([-50, 40], [20, 40]), 0, 8, 1000)).toEqual([-50, 20])
  })

  it('places nothing for no cards', () => {
    expect(placeCards([], -1, 8, 1000)).toEqual([])
  })
})

describe('fitColumn', () => {
  const bounds = {min: 240, max: 520}

  it('leaves the text where it is when the right side already holds the widest column', () => {
    expect(fitColumn({left: 900, right: 900}, bounds)).toEqual({width: 520, shift: 0})
    expect(fitColumn({left: 520, right: 520}, bounds)).toEqual({width: 520, shift: 0})
  })

  it('moves the text left by only what the widest column still needs', () => {
    expect(fitColumn({left: 460, right: 444}, bounds)).toEqual({width: 520, shift: 76})
  })

  it('never moves the text past the room on its left', () => {
    expect(fitColumn({left: 100, right: 300}, bounds)).toEqual({width: 400, shift: 100})
  })

  it('fits a column the right side could not hold alone', () => {
    expect(fitColumn({left: 120, right: 120}, bounds)).toEqual({width: 240, shift: 120})
  })

  it('refuses a column under the minimum, even with the text moved all the way', () => {
    expect(fitColumn({left: 119, right: 120}, bounds)).toBeNull()
  })

  it('treats a text frame wider than the pane as no room on either side', () => {
    expect(fitColumn({left: -16, right: -32}, bounds)).toBeNull()
    expect(fitColumn({left: -16, right: 300}, bounds)).toEqual({width: 300, shift: 0})
  })

  it('gives whole pixels, so the text never lands between them', () => {
    expect(fitColumn({left: 100.5, right: 300.5}, bounds)).toEqual({width: 400, shift: 100})
  })
})

describe('byPlacement', () => {
  const card = (name: string, row: number, anchor: number, order: number, trailing = false) =>
    ({name, row, anchor, order, trailing})
  const sorted = (...cards: Array<MarginCard & {name: string}>) => cards.sort(byPlacement).map(c => c.name)

  it('orders a row by where each card sits, not its stored order', () => {
    expect(sorted(card('a', 0, 200, 0), card('b', 0, 20, 1))).toEqual(['b', 'a'])
  })

  it('keeps rows in outline order, and a trailing card last in its row', () => {
    expect(sorted(card('next row', 1, 0, 0), card('stub', 0, 0, 0, true), card('quote', 0, 300, 1)))
      .toEqual(['quote', 'stub', 'next row'])
  })

  it('breaks a tie in place by stored order', () => {
    expect(sorted(card('b', 0, 10, 1), card('a', 0, 10, 0))).toEqual(['a', 'b'])
  })
})
