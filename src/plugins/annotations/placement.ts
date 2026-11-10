export interface MarginCard {
  /** Its row's index in outline order. */
  row: number
  /** Where the card wants its top. */
  anchor: number
  /** Kept after its row's other cards whatever its anchor: it stands for
   *  threads in the rows below. */
  trailing: boolean
  /** Position among its block's cards, breaking ties. */
  order: number
}

/** The order `placeCards` takes cards in: by row, then by where each sits in
 *  it, not by the stored quote position, which moving text leaves behind. */
export const byPlacement = (a: MarginCard, b: MarginCard): number =>
  a.row - b.row || Number(a.trailing) - Number(b.trailing) || a.anchor - b.anchor || a.order - b.order

export interface CardBox {
  /** Where the card wants its top: its target row's top. */
  anchor: number
  height: number
}

/** Card tops for `cards`, given in document order, in a view `viewHeight`
 *  tall. Each card sits at its anchor or just below the card above, whichever
 *  is lower. The focused card (an index; -1 for none) stays at its anchor
 *  instead, while that anchor is in view: the cards below it are pushed down
 *  from it, and the cards above it are pushed up, each to just above the
 *  next, so none overlaps it. A focused card whose row is scrolled away has
 *  nothing to stay beside, and pinning it would push the cards in view away
 *  from theirs. */
export const placeCards = (cards: readonly CardBox[], focused: number, gap: number, viewHeight: number): number[] => {
  const tops: number[] = []
  for (const [i, card] of cards.entries()) {
    tops.push(i === 0 ? card.anchor : Math.max(card.anchor, tops[i - 1] + cards[i - 1].height + gap))
  }
  const anchor = cards[focused]?.anchor
  if (anchor === undefined || anchor < 0 || anchor >= viewHeight) return tops
  tops[focused] = cards[focused].anchor
  for (let i = focused + 1; i < cards.length; i++) {
    tops[i] = Math.max(cards[i].anchor, tops[i - 1] + cards[i - 1].height + gap)
  }
  for (let i = focused - 1; i >= 0; i--) {
    tops[i] = Math.min(tops[i], tops[i + 1] - cards[i].height - gap)
  }
  return tops
}

export interface ColumnFit {
  width: number
  /** How much of the pane's right side the text gives up: it centres in what
   *  is left. */
  clearance: number
  /** The column's left edge, from the pane's. */
  left: number
}

export interface ColumnFitInput {
  pane: number
  /** The share of the pane the user set the column to, so it keeps its
   *  proportion when the pane narrows; absent, the column takes the side room
   *  the full text leaves, or a third of the pane, whichever is wider. */
  share?: number
  text: {min: number; max: number}
  /** `max` bounds the automatic width only: a set width is bounded by the
   *  text's minimum. */
  column: {min: number; max: number}
  /** The gap between text and column, and right of the column. */
  edge: number
}

/** Where the column goes in a pane `pane` wide, or null when not even the
 *  column's minimum fits beside the text's. The text keeps its full width and
 *  moves left only as far as the column needs; past that it narrows, down to
 *  its minimum, and only then does the column give up width. */
export const fitColumn = ({pane, share, text, column, edge}: ColumnFitInput): ColumnFit | null => {
  const width = Math.floor(pane)
  const automatic = Math.min(column.max, Math.max(width - text.max - 2 * edge, Math.floor(width / 3)))
  let columnWidth = Math.max(column.min, Math.floor(share === undefined ? automatic : share * width))
  const fullTextClearance = Math.max(0, text.max + 2 * columnWidth + 4 * edge - width)
  if (fullTextClearance <= width - text.max) {
    return {
      width: columnWidth,
      clearance: fullTextClearance,
      left: Math.floor((width - fullTextClearance + text.max) / 2) + edge,
    }
  }
  columnWidth = Math.min(columnWidth, width - 2 * edge - text.min)
  if (columnWidth < column.min) return null
  const clearance = columnWidth + 2 * edge
  return {width: columnWidth, clearance, left: width - clearance + edge}
}
