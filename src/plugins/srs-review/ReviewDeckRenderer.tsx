import type { BlockRenderer, BlockRendererProps } from '@/types.js'
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.js'
import { getBlockTypes } from '@/data/properties.js'
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
export const SrsReviewDeckRenderer: BlockRenderer = Object.assign(
  (props: BlockRendererProps) => (
    <DefaultBlockRenderer
      {...props}
      ContentRenderer={ReviewDeckContent}
      EditContentRenderer={ReviewDeckContent}
    />
  ),
  {
    canRender: ({block}: BlockRendererProps): boolean => {
      const data = block.peek()
      return !!data && getBlockTypes(data).includes(SRS_REVIEW_DECK_TYPE)
    },
    priority: () => 100,
  },
)
SrsReviewDeckRenderer.displayName = 'SrsReviewDeckRenderer'
