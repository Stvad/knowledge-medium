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
 *  instead while its row is in view, and at the view's edge once the row is
 *  scrolled past it, so it can be read while the outline scrolls on its own:
 *  the cards below it are pushed down from it, and the cards above it are
 *  pushed up, each to just above the next, so none overlaps it. */
export const placeCards = (cards: readonly CardBox[], focused: number, gap: number, viewHeight: number): number[] => {
  const tops: number[] = []
  for (const [i, card] of cards.entries()) {
    tops.push(i === 0 ? card.anchor : Math.max(card.anchor, tops[i - 1] + cards[i - 1].height + gap))
  }
  const pinned = cards[focused]
  if (pinned === undefined) return tops
  tops[focused] = pinned.anchor < 0 ? 0 : pinned.anchor >= viewHeight ? viewHeight - pinned.height : pinned.anchor
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
  // Rounded: a share stored to a few places lands a hair either side of the
  // width it was taken from.
  let columnWidth = Math.max(column.min, share === undefined ? automatic : Math.round(share * width))
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

interface Span {
  top: number
  bottom: number
}

/** How far to scroll, down when positive, for `box` to show inside `clip`,
 *  `gap` in from its edges: none when it already does, and the top of a box
 *  taller than the clip. */
export const scrollToShow = (box: Span, clip: Span, gap: number): number => {
  const toTop = box.top - clip.top - gap
  if (toTop < 0) return toTop
  const toBottom = box.bottom - clip.bottom + gap
  return toBottom > 0 ? Math.min(toBottom, toTop) : 0
}

/** The card after (`1`) or before (`-1`) `active` in placement order;
 *  undefined past either end, or when `active` isn't placed. */
export const adjacentCard = (order: readonly string[], active: string, step: 1 | -1): string | undefined => {
  const at = order.indexOf(active)
  return at < 0 ? undefined : order[at + step]
}

/** Is `span`, measured from the view's top, wholly outside a view `height`
 *  tall? */
export const outOfView = (span: Span, height: number): boolean => span.bottom <= 0 || span.top >= height

export interface PinState {
  /** The user is scrolling the page (a wheel or touch on it, and the scroll
   *  it carries on into), not the app. */
  userScrolling: boolean
  /** Focus is in the pinned card: the user is writing or reading in it. */
  holdsFocus: boolean
  /** The pinned card is placed here; a pin from another page is not. */
  placed: boolean
  /** Whether its row was in view on the last pass; undefined on the first. */
  wasInView: boolean | undefined
  inView: boolean
}

/** Does the pinned card go back to its row? When the user's own scrolling
 *  takes its row out of view, so a card pinned with its row already out of
 *  view (a link in it scrolled the page away) stays until the user brings the
 *  row back and scrolls past it. */
export const releasesPin = ({userScrolling, holdsFocus, placed, wasInView, inView}: PinState): boolean =>
  userScrolling && !holdsFocus && (!placed || (wasInView === true && !inView))

export interface MarginWheelState {
  /** Inside the pause after moving on to another card. */
  paused: boolean
  horizontal: boolean
  /** A scroller between the wheel's target and the card has room that way. */
  innerCanScroll: boolean
  /** Over the active card. */
  overActive: boolean
  /** The column cuts off the active card's side the wheel scrolls toward. */
  activeClipped: boolean
  holdsFocus: boolean
  /** There is a card to move on to that way. */
  hasNext: boolean
}

export type MarginWheelAction = 'native' | 'drop' | 'reveal' | 'move-on' | 'page'

/** What a wheel over the margin does: scroll what it is over, show the rest
 *  of the active card, move on to the next card past its end, or scroll the
 *  page. Writing in the active card keeps it: the wheel scrolls the page. */
export const marginWheel = (state: MarginWheelState): MarginWheelAction => {
  if (state.paused) return 'drop'
  if (state.horizontal || state.innerCanScroll) return 'native'
  if (!state.overActive || state.holdsFocus) return 'page'
  if (state.activeClipped) return 'reveal'
  return state.hasNext ? 'move-on' : 'page'
}
