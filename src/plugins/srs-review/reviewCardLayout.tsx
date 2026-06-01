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

export const srsReviewCardLayoutContribution: BlockLayoutContribution = ctx => {
  const cardId = ctx.blockContext?.[SRS_REVIEW_CARD_ID]
  // Only the card root, and only while its answer is hidden. Once
  // revealed we return null so the default layout renders content +
  // children. Descendants never match (their id differs from cardId).
  if (cardId !== ctx.block.id) return null
  if (ctx.blockContext?.[SRS_REVIEW_REVEALED]) return null
  return {
    id: 'srs-review.question-only',
    label: 'SRS review question',
    render: QuestionOnlyLayout,
  }
}
