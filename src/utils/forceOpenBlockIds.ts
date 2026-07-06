import type { Block } from '@/data/block'

interface ForceOpenBlockIdsOptions {
  /** The anchor row the surface is centered on (backlink card or review card). */
  anchorId: string
  /** The currently rendered root of the surface. */
  shownBlockId: string
  /** Ancestor chain for the anchor, root → ... → immediate parent. */
  anchorParents: readonly Block[]
}

/** Build a stable set of block ids that should render expanded even if
 *  collapsed by persisted state. Includes the surface root, the anchor
 *  itself, and the anchor ancestry so collapsed intermediates don’t
 *  hide the anchored card while breadcrumbs are unfurled. */
export const buildForceOpenBlockIds = (
  {anchorId, shownBlockId, anchorParents}: ForceOpenBlockIdsOptions,
): readonly string[] => {
  const ordered = [shownBlockId, ...anchorParents.map(b => b.id), anchorId]
  return [...new Set(ordered)]
}
