export interface CardBox {
  /** Where the card wants its top: its target row's top. */
  anchor: number
  height: number
}

/** Card tops for `cards`, given in document order. Each card sits at its
 *  anchor or just below the card above, whichever is lower. The focused card
 *  (an index, or null) stays at its anchor instead: the cards below it are
 *  pushed down from it, and the cards above it are pushed up, each to just
 *  above the next, so none overlaps it. */
export const placeCards = (cards: readonly CardBox[], focused: number | null, gap: number): number[] => {
  const tops: number[] = []
  for (const [i, card] of cards.entries()) {
    tops.push(i === 0 ? card.anchor : Math.max(card.anchor, tops[i - 1] + cards[i - 1].height + gap))
  }
  if (focused === null || focused < 0 || focused >= cards.length) return tops
  tops[focused] = cards[focused].anchor
  for (let i = focused + 1; i < cards.length; i++) {
    tops[i] = Math.max(cards[i].anchor, tops[i - 1] + cards[i - 1].height + gap)
  }
  for (let i = focused - 1; i >= 0; i--) {
    tops[i] = Math.min(tops[i], tops[i + 1] - cards[i].height - gap)
  }
  return tops
}
