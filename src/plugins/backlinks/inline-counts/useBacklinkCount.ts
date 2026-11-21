import type { Block } from '@/data/block'
import { useHandle } from '@/hooks/block.js'
import { BACKLINKS_COUNT_FOR_BLOCK_QUERY } from './countQuery.ts'

/** Backlink count for the inline badge (`backlinks.countForBlock`). The result
 *  is a primitive, so `useHandle`'s equality bail-out re-renders the badge only
 *  when the count actually changes. */
export const useBacklinkCount = (block: Block, workspaceId: string): number =>
  useHandle(
    block.repo.query[BACKLINKS_COUNT_FOR_BLOCK_QUERY]({ workspaceId, id: block.id }),
    { selector: (count) => count ?? 0 },
  )
