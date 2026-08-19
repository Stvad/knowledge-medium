import type { BlockRenderer, BlockRendererProps } from '@/types.js'
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.js'
import type { BlockRendererRegistration } from '@/extensions/blockInteraction.js'
import { usePropertyValue } from '@/hooks/block.js'
import {
  SRS_REVIEW_DECK_TYPE,
  reviewDeckStartedProp,
  reviewDeckTagProp,
} from './schema.ts'
import { DeckPicker } from './DeckPicker.tsx'
import { ReviewSession } from './ReviewSession.tsx'

/** Content area for a review-deck page: the deck picker until a deck is
 *  started, then the review session. Keyed on the tag so picking a
 *  different deck restarts the session cleanly. */
const ReviewDeckContent: BlockRenderer = ({block}: BlockRendererProps) => {
  const [started] = usePropertyValue(block, reviewDeckStartedProp)
  const [tagName] = usePropertyValue(block, reviewDeckTagProp)
  if (!started) return <DeckPicker deck={block} />
  return <ReviewSession key={tagName} deck={block} tagName={tagName} />
}
ReviewDeckContent.displayName = 'ReviewDeckContent'

/** Outer wrapper: keep the default block frame, swap the content area
 *  for the deck UI. Mirrors BlockTypeBlockRenderer / video-player. */
export const SrsReviewDeckRenderer: BlockRenderer = (props: BlockRendererProps) => (
  <DefaultBlockRenderer
    {...props}
    ContentRenderer={ReviewDeckContent}
    contentShowsOtherBlocks
    EditContentRenderer={ReviewDeckContent}
  />
)
SrsReviewDeckRenderer.displayName = 'SrsReviewDeckRenderer'

export const srsReviewDeckRendererRegistration: BlockRendererRegistration = {
  id: 'srsReviewDeck',
  label: 'SRS review deck',
  resolve: ctx =>
    ctx.types.includes(SRS_REVIEW_DECK_TYPE) ? {render: SrsReviewDeckRenderer} : null,
}
