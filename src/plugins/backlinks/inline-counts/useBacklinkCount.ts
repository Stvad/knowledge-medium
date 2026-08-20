import type { Block } from '@/data/block'
import { useHandle } from '@/hooks/block.js'
import { BACKLINKS_COUNT_FOR_BLOCK_QUERY } from './countQuery.ts'

/** Backlink count for the inline badge. It resolves `backlinks.forBlock` and
 *  takes its length, so a heavily-referenced block DOES marshal the id list
 *  here. That is the price of badge/list parity: the machinery exclusion is a
 *  post-filter on ids, so any count that skips it disagrees with the list the
 *  user gets on expand. The SQL `COUNT(*)` fast path this used to take when a
 *  workspace was un-flipped is gone with the premise behind it — the backfill
 *  mints machinery before the flip — and post-flip it never applied anyway. The result is a primitive, so `useHandle`'s equality
 *  bail-out re-renders the badge only when the count actually changes. */
export const useBacklinkCount = (block: Block, workspaceId: string): number =>
  useHandle(
    block.repo.query[BACKLINKS_COUNT_FOR_BLOCK_QUERY]({ workspaceId, id: block.id }),
    { selector: (count) => count ?? 0 },
  )
