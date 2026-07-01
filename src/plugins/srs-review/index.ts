import { ArchiveX, GraduationCap } from 'lucide-react'
import type { Repo } from '@/data/repo'
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { actionContextsFacet, actionsFacet, blockRenderersFacet } from '@/extensions/core.js'
import { blockLayoutFacet } from '@/extensions/blockInteraction.js'
import {
  ActionConfig,
  ActionContextTypes,
  BlockShortcutDependencies,
} from '@/shortcuts/types.js'
import { getBlockTypes } from '@/data/properties.js'
import { navigateFromGlobalCommand } from '@/utils/navigation.js'
import { dailyNotesDataExtension } from '@/plugins/daily-notes'
import { SRS_SM25_TYPE, srsReschedulingDataExtension } from '@/plugins/srs-rescheduling'
import { referencesDataExtension } from '@/plugins/references/dataExtension.js'
import { blockTaggingDataExtension } from '@/plugins/block-tagging/dataExtension.js'
import { srsReviewDataExtension } from './dataExtension.ts'
import { SrsReviewDeckRenderer } from './ReviewDeckRenderer.tsx'
import { srsReviewCardLayoutContribution } from './reviewCardLayout.tsx'
import { getOrCreateReviewDeck } from './deck.ts'
import { archiveSrsCard } from './archive.ts'
import { srsReviewActionContext, srsReviewActions } from './actions.ts'

export const OPEN_SRS_REVIEW_ACTION_ID = 'open_srs_review'
export const SRS_ARCHIVE_ACTION_ID = 'srs.archive'

const openReviewAction = (
  repo: Repo,
): ActionConfig<typeof ActionContextTypes.GLOBAL> => ({
  id: OPEN_SRS_REVIEW_ACTION_ID,
  description: 'Open SRS review',
  context: ActionContextTypes.GLOBAL,
  icon: GraduationCap,
  handler: async () => {
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) return
    const deck = await getOrCreateReviewDeck(repo, workspaceId)
    navigateFromGlobalCommand(repo, {blockId: deck.id, workspaceId})
  },
  defaultBinding: {
    keys: 'Control+Shift+r',
  },
})

// Reusable inline / command-palette archive, gated to SRS cards. The
// review session has its own button, but exposing the action lets a
// card be archived from the outline or palette without opening review.
const srsArchiveAction: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
  id: SRS_ARCHIVE_ACTION_ID,
  description: 'SRS: Archive card',
  context: ActionContextTypes.NORMAL_MODE,
  icon: ArchiveX,
  isVisible: ({block}) => {
    const data = block.peek()
    return !!data && getBlockTypes(data).includes(SRS_SM25_TYPE)
  },
  handler: async ({block}: BlockShortcutDependencies) => {
    await archiveSrsCard(block)
  },
}

export const srsReviewPlugin = ({repo}: {repo: Repo}): AppExtension =>
  systemToggle({
    id: 'system:srs-review',
    name: 'SRS review',
    description: 'Deck-based review mode for spaced-repetition cards due today or earlier.',
  }).of([
    // SRS Review hard-depends on the spaced-repetition stack: the
    // due-cards query reads the SRS and daily-note schemas, matches tags
    // through the references index, and the picker lists tags from the
    // block-tagging config. Bundle each dependency's data extension so
    // the deck works whenever review is enabled; FacetContribution dedup
    // (by reference) keeps every contribution registered exactly once
    // when the source plugins are independently enabled too.
    srsReschedulingDataExtension,
    dailyNotesDataExtension,
    referencesDataExtension,
    blockTaggingDataExtension,
    srsReviewDataExtension,
    blockRenderersFacet.of(
      {id: 'srsReviewDeck', renderer: SrsReviewDeckRenderer},
      {source: 'srs-review'},
    ),
    blockLayoutFacet.of(srsReviewCardLayoutContribution, {source: 'srs-review'}),
    actionsFacet.of(openReviewAction(repo), {source: 'srs-review'}),
    actionsFacet.of(srsArchiveAction, {source: 'srs-review'}),
    // In-session reveal / grade shortcuts: a dedicated modal context the
    // review surface activates while focused (see ReviewSession).
    actionContextsFacet.of(srsReviewActionContext, {source: 'srs-review'}),
    srsReviewActions.map(action => actionsFacet.of(action, {source: 'srs-review'})),
  ])

export {
  SRS_REVIEW_DECK_TYPE,
  reviewDeckStartedProp,
  reviewDeckTagProp,
  srsReviewDeckType,
} from './schema.ts'
export { buildDueCardsQuery, dueBoundary } from './dueQuery.ts'
export { getOrCreateReviewDeck, reviewDeckBlockId } from './deck.ts'

export default srsReviewPlugin
