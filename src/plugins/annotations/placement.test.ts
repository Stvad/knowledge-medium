// @vitest-environment node
import {describe, expect, it} from 'vitest'
import {adjacentCard, byPlacement, fitColumn, outOfView, placeCards, scrollToShow, type MarginCard} from './placement'

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

  it('keeps the focused card in view while its row is scrolled away, the others flowing around it', () => {
    expect(placeCards(cards([0, 80], [20, 40], [1200, 40]), 2, 8, 1000)).toEqual([0, 88, 960])
    expect(placeCards(cards([-50, 40], [20, 40]), 0, 8, 1000)).toEqual([0, 48])
    expect(placeCards(cards([-900, 40], [-500, 300], [-100, 40]), 1, 8, 1000)).toEqual([-900, 0, 308])
  })

  it('tops a focused card taller than the view at the view’s top once its row is above it', () => {
    expect(placeCards(cards([-200, 1500]), 0, 8, 1000)).toEqual([0])
  })

  it('leaves a focused card whose row is in view at its row, so activating it never moves it', () => {
    expect(placeCards(cards([600, 900]), 0, 8, 1000)).toEqual([600])
  })

  it('places nothing for no cards', () => {
    expect(placeCards([], -1, 8, 1000)).toEqual([])
  })
})

describe('fitColumn', () => {
  const bounds = {
    text: {min: 480, max: 768},
    column: {min: 240, max: 520},
    edge: 16,
  }
  const fit = (pane: number, share?: number) => fitColumn({pane, share, ...bounds})

  it('leaves the text centred when the side beside it holds the widest column', () => {
    expect(fit(2000)).toEqual({width: 520, clearance: 0, left: 1400})
  })

  it('moves the text left, unchanged in width, by only what the column still needs', () => {
    expect(fit(1700)).toEqual({width: 520, clearance: 172, left: 1164})
  })

  it('narrows the text rather than dropping the column in a pane split in two', () => {
    expect(fit(1000)).toEqual({width: 333, clearance: 365, left: 651})
  })

  it('takes a set share of the pane over the automatic width, past the automatic maximum', () => {
    expect(fit(2000, 0.35)).toEqual({width: 700, clearance: 232, left: 1284})
  })

  it('gives back the width a share was taken from', () => {
    // 611 / 1500 stores as 0.4073, a hair under the ratio.
    expect(fit(1500, 0.4073)?.width).toBe(611)
  })

  it('keeps a set share in a narrower pane, so the text narrows with the column', () => {
    expect(fit(1200, 0.35)).toEqual({width: 420, clearance: 452, left: 764})
  })

  it('gives up set share before the text goes under its minimum', () => {
    expect(fit(1000, 0.7)).toEqual({width: 488, clearance: 520, left: 496})
  })

  it('never goes under the column minimum, even when set narrower', () => {
    expect(fit(2000, 0.05)).toEqual({width: 240, clearance: 0, left: 1400})
  })

  it('refuses a pane that holds the text minimum but not the column minimum beside it', () => {
    expect(fit(752)).toEqual({width: 240, clearance: 272, left: 496})
    expect(fit(751)).toBeNull()
    expect(fit(751, 0.9)).toBeNull()
  })

  it('gives whole pixels, so the text never lands between them', () => {
    expect(fit(1000.7)).toEqual({width: 333, clearance: 365, left: 651})
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

describe('scrollToShow', () => {
  const clip = {top: 100, bottom: 900}

  it('leaves a box that shows alone', () => {
    expect(scrollToShow({top: 200, bottom: 300}, clip, 8)).toBe(0)
  })

  it('scrolls a box below the clip up to its foot', () => {
    expect(scrollToShow({top: 1000, bottom: 1100}, clip, 8)).toBe(208)
  })

  it('scrolls a box above the clip down to its head', () => {
    expect(scrollToShow({top: 20, bottom: 60}, clip, 8)).toBe(-88)
  })

  it('shows the top of a box taller than the clip', () => {
    expect(scrollToShow({top: 1000, bottom: 2500}, clip, 8)).toBe(892)
  })
})

describe('adjacentCard', () => {
  const order = ['a', 'hidden:x', 'b', 'c']
  const standIn = (key: string) => key.startsWith('hidden:')

  it('is the next or previous card in placement order, past stand-ins', () => {
    expect(adjacentCard(order, 'a', 1, standIn)).toBe('b')
    expect(adjacentCard(order, 'b', -1, standIn)).toBe('a')
    expect(adjacentCard(order, 'b', 1, standIn)).toBe('c')
  })

  it('is none past either end, or for a card not placed', () => {
    expect(adjacentCard(order, 'c', 1, standIn)).toBeUndefined()
    expect(adjacentCard(order, 'a', -1, standIn)).toBeUndefined()
    expect(adjacentCard(order, 'gone', 1, standIn)).toBeUndefined()
  })
})

describe('outOfView', () => {
  it('is a span wholly above or below the view', () => {
    expect(outOfView({top: -50, bottom: 0}, 1000)).toBe(true)
    expect(outOfView({top: 1000, bottom: 1040}, 1000)).toBe(true)
    expect(outOfView({top: -50, bottom: 1}, 1000)).toBe(false)
    expect(outOfView({top: 999, bottom: 1040}, 1000)).toBe(false)
  })
})
