import type { BlockData } from '@/data/api'
import { PAGE_TYPE } from '@/data/blockTypes.ts'
import { hasBlockType } from '@/data/properties.ts'
import type { ContentStrategy } from '@/data/internals/kernelMutators.ts'

/**
 * Pick the `contentStrategy` for a binary merge based on the two blocks'
 * types. Pages don't compose by concatenation — two prose bodies stitched
 * together produce a mess — so anything page-flavoured uses `keepTarget`
 * (and `keepTarget`'s empty-target fallback covers the canonical-stub-
 * absorbs-real-page case). Outline blocks keep the Backspace-style
 * `'concat'` behaviour so an interactive "merge this into the picked
 * block" feels consistent with what Backspace already does.
 */
export const pickMergeContentStrategy = (
  sourceData: BlockData,
  targetData: BlockData,
): ContentStrategy => {
  if (hasBlockType(sourceData, PAGE_TYPE) || hasBlockType(targetData, PAGE_TYPE)) {
    return 'keepTarget'
  }
  return 'concat'
}
