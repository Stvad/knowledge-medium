import type { Block } from '@/data/block'
import { useHandle } from '@/hooks/block.js'
import { BACKLINKS_FOR_BLOCK_QUERY } from '../query.ts'

/** Backlink count for the inline badge. Reuses the *same* `backlinks.forBlock`
 *  handle the expanded Linked References list subscribes to — so the count and
 *  the list are computed once and can never disagree — but selects only its
 *  length. `backlinks.forBlock` returns ids (no block hydration), so counting
 *  is the cheap membership path: the expensive hydration/render only happens
 *  when the user expands the section.
 *
 *  The `.length` selector returns a primitive, so `useHandle`'s equality
 *  bail-out re-renders the badge only when the count actually changes (a
 *  reference swapped for another keeps the same length → no re-render).
 *
 *  Heavy-tail note: a block referenced thousands of times still materialises
 *  the full id array here just to count it. In practice such blocks are the
 *  ones you zoom into (focal → no badge), so they're excluded; if profiling
 *  ever shows the id marshalling matters, a dedicated `COUNT` projection on
 *  the typed-block compiler is the drop-in optimisation. */
export const useBacklinkCount = (block: Block, workspaceId: string): number =>
  useHandle(
    block.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({ workspaceId, id: block.id }),
    { selector: (ids) => ids?.length ?? 0 },
  )
