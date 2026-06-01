import type {
  BlockLayoutContribution,
  BlockLayoutSlots,
} from '@/extensions/blockInteraction.js'

/** Block-context keys the review session sets on the card it's showing
 *  so the layout below can hide the answer (children) until the user
 *  reveals it. Mirrors the video-player pattern: a context-gated
 *  `blockLayoutFacet` contribution that self-gates on a flag the
 *  surrounding surface sets, and falls through to the default layout
 *  for every other block. */
export const SRS_REVIEW_CARD_ID = 'srsReviewCardId'
export const SRS_REVIEW_REVEALED = 'srsReviewRevealed'

/** Question phase: render the card's own content only, dropping the
 *  children subtree (the answer). */
const QuestionOnlyLayout = ({Content}: BlockLayoutSlots) => (
  <div className="srs-review-card-question min-w-0">
    <Content />
  </div>
)

/** Answer phase: render content + the children subtree directly. We do
 *  NOT fall back to the default layout here — its `Collapsible` only
 *  opens for a non-collapsed or top-level block, and the review surface
 *  is `isNestedSurface`, so a card that's collapsed in the outline would
 *  reveal no answer at all. Rendering `Children` raw shows the answer
 *  regardless of the card's stored collapse state. */
const AnswerLayout = ({Content, Children}: BlockLayoutSlots) => (
  <div className="srs-review-card-answer min-w-0">
    <Content />
    <Children />
  </div>
)

export const srsReviewCardLayoutContribution: BlockLayoutContribution = ctx => {
  // Only the card root — descendants never match (their id differs from
  // cardId), so they keep the default layout. The card itself uses a
  // dedicated layout for each phase rather than ever falling through to
  // the default (which would respect collapse and could hide the answer).
  const cardId = ctx.blockContext?.[SRS_REVIEW_CARD_ID]
  if (cardId !== ctx.block.id) return null
  const revealed = Boolean(ctx.blockContext?.[SRS_REVIEW_REVEALED])
  return revealed
    ? {id: 'srs-review.answer', label: 'SRS review answer', render: AnswerLayout}
    : {id: 'srs-review.question-only', label: 'SRS review question', render: QuestionOnlyLayout}
}
