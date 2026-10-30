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
