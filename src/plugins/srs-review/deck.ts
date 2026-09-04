import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { ChangeScope } from '@/data/api'
import { getOrCreateKernelPage, kernelPageBlockId } from '@/data/kernelPage.js'
import {
  SRS_REVIEW_DECK_TYPE,
  reviewDeckStartedProp,
  reviewDeckTagProp,
} from './schema.ts'

// Fresh uuid-v5 namespace so each workspace's review deck lands on one
// deterministic row — re-launching review reuses the same block (and
// its last-picked deck) rather than spawning a new page each time.
const REVIEW_DECK_NS = 'c3f1a9d4-2b8e-4f57-bc6a-1e9d8a4f2c70'
const REVIEW_DECK_ALIAS = 'SRS Review'

export const reviewDeckBlockId = (workspaceId: string): string =>
  kernelPageBlockId(workspaceId, REVIEW_DECK_NS)

/** Get-or-create the workspace's singleton review-deck page. Shares the
 *  kernel-page bootstrap (deterministic id, PAGE_TYPE + marker type,
 *  restore-on-reach) with Recents / Properties / Types. The
 *  `srs-review-deck` marker is what `SrsReviewDeckRenderer.canRender`
 *  keys on. */
export const getOrCreateReviewDeck = (repo: Repo, workspaceId: string): Promise<Block> =>
  getOrCreateKernelPage(repo, workspaceId, {
    namespace: REVIEW_DECK_NS,
    alias: REVIEW_DECK_ALIAS,
    markerType: SRS_REVIEW_DECK_TYPE,
  })

/** Point the deck at a tag (`''` = all due) and flip it into the review
 *  session. Shared by the deck picker and the daily-note hint, so both
 *  start a deck the same way. */
export const startReviewDeck = async (deck: Block, tagName: string): Promise<void> => {
  await deck.repo.tx(
    async tx => {
      await tx.setProperty(deck.id, reviewDeckTagProp, tagName)
      await tx.setProperty(deck.id, reviewDeckStartedProp, true)
    },
    {scope: ChangeScope.BlockDefault, description: 'start srs review deck'},
  )
}
