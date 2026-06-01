import { ChangeScope, codecs, defineBlockType, defineProperty } from '@/data/api'

export const SRS_REVIEW_DECK_TYPE = 'srs-review-deck'

/** The tag a deck reviews, stored as the bare page name (matching
 *  `blockTagsConfigProp`). Resolved to a block id at query time via
 *  `core.aliasLookup`. Empty string is the "all due" deck — every SRS
 *  card due today or earlier, regardless of tag. */
export const reviewDeckTagProp = defineProperty<string>('srs-review:deck-tag', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

/** False until the user picks a deck in the in-place picker; flips the
 *  deck renderer from the picker to the review session. A persisted
 *  flag (rather than React state) so reopening the deck block resumes
 *  the chosen deck instead of dropping back to the picker. The session
 *  writes it back to false via its "Change deck" affordance. */
export const reviewDeckStartedProp = defineProperty<boolean>('srs-review:deck-started', {
  codec: codecs.boolean,
  defaultValue: false,
  changeScope: ChangeScope.BlockDefault,
})

export const srsReviewDeckType = defineBlockType({
  id: SRS_REVIEW_DECK_TYPE,
  label: 'SRS review deck',
  properties: [reviewDeckTagProp, reviewDeckStartedProp],
})
