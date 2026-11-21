import { ChangeScope, seedProperty, seedType, INFRASTRUCTURE_TYPE_DISPLAY } from '@/data/api'

export const SRS_REVIEW_DECK_TYPE = 'srs-review-deck'

/** The tag a deck reviews, stored as the bare page name (matching
 *  `blockTagsConfigProp`). Resolved to a block id at query time via
 *  `core.aliasLookup`. Empty string is the "all due" deck — every SRS
 *  card due today or earlier, regardless of tag. */
export const reviewDeckTagProp = seedProperty({
  seedKey: 'system:srs-review/property/deck-tag',
  revision: 1,
  name: 'srs-review:deck-tag',
  preset: 'string',
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

/** False until the user picks a deck in the in-place picker; flips the
 *  deck renderer from the picker to the review session. A persisted
 *  flag (rather than React state) so reopening the deck block resumes
 *  the chosen deck instead of dropping back to the picker. The session
 *  writes it back to false via its "Change deck" affordance. */
export const reviewDeckStartedProp = seedProperty({
  seedKey: 'system:srs-review/property/deck-started',
  revision: 1,
  name: 'srs-review:deck-started',
  preset: 'boolean',
  defaultValue: false,
  changeScope: ChangeScope.BlockDefault,
})

export const srsReviewDeckType = seedType({
  seedKey: 'system:srs-review/type/srs-review-deck',
  revision: 1,
  id: SRS_REVIEW_DECK_TYPE,
  label: 'SRS review deck',
  properties: [reviewDeckTagProp, reviewDeckStartedProp],
})

/** Decks whose due count is surfaced on today's daily note, as deck tags
 *  (`''` is the all-due deck, matching `reviewDeckTagProp`). `null` means
 *  never configured — the hint then shows the all-due deck, so the surface
 *  works before the user has picked anything. An explicit `[]` is "none":
 *  the user deselected every deck, and the hint stays off. */
export const dailyNoteDecksProp = seedProperty<string[] | null>({
  seedKey: 'system:srs-review/property/daily-note-decks',
  revision: 1,
  name: 'srs-review:daily-note-decks',
  preset: 'json',
  defaultValue: null,
  changeScope: ChangeScope.UserPrefs,
})

/** Stored prefs are untrusted (older builds, hand edits): keep strings only,
 *  first occurrence wins. `''` is preserved — it names the all-due deck — so
 *  `uniqueStrings` (which drops empties) doesn't fit here. */
export const normalizeDailyNoteDecks = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) return null
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/** Per-plugin prefs sub-block for SRS review. Holds the daily-note deck
 *  selection. */
export const srsReviewPrefsType = seedType({
  seedKey: 'system:srs-review/type/srs-review-prefs',
  revision: 1,
  id: 'srs-review-prefs',
  label: 'SRS review',
  properties: [dailyNoteDecksProp],
})

export const SRS_REVIEW_PROGRESS_TYPE = 'srs-review-progress'

/** A frozen review session's persisted state. Stored on a per-deck child
 *  of the plugin's ui-state block (see `usePluginUIStateChildBlock`, keyed
 *  by deck id) so each deck keeps its own session across navigating away
 *  and back — both the user's place (`index`/`revealed`) and the frozen
 *  card order (`queue`), so returning doesn't re-run the due-cards query or
 *  restart at card one. `tag` and `day` still scope the saved state:
 *  retagging the deck, or a midnight rollover, invalidates it so the queue
 *  rebuilds from the live due set instead of resuming a stale one. */
export interface ReviewProgress {
  queue: string[]
  index: number
  revealed: boolean
  tag: string
  day: string
}

/** Single object property (one write per state change) rather than five
 *  scalar props. `ChangeScope.UiState` routes it into the ui-state
 *  subtree, undo-segregated from document edits — it's session/UI state,
 *  not document content. */
export const reviewProgressProp = seedProperty<ReviewProgress | null>({
  seedKey: 'system:srs-review/property/progress',
  revision: 1,
  name: 'srs-review:progress',
  preset: 'json',
  defaultValue: null,
  changeScope: ChangeScope.UiState,
})

export const srsReviewProgressType = seedType({
  seedKey: 'system:srs-review/type/srs-review-progress',
  revision: 1,
  id: SRS_REVIEW_PROGRESS_TYPE,
  label: 'SRS review progress',
  ...INFRASTRUCTURE_TYPE_DISPLAY,
  properties: [reviewProgressProp],
})
