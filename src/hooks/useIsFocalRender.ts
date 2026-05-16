import type { Block } from '@/data/block.ts'
import { useBlockContext } from '@/context/block.tsx'
import { useUIStateProperty } from '@/data/globalState.ts'
import { topLevelBlockIdProp } from '@/data/properties.ts'
import type { BlockResolveContext } from '@/extensions/blockInteraction.ts'

/**
 * "Is this block being rendered as the document body of its panel?" —
 * the question the five top-level affordances (force-open, hide-bullet,
 * top-level CSS, breadcrumbs header, backlinks footer) all want to
 * answer.
 *
 * Two axes are tangled in the naive `block.id === topLevelBlockId`
 * check: focal-block identity (correct) and render surface (missing).
 * An embed of the focal block, or a backlink entry whose shown block
 * happens to equal the focal block, both pass the id check but should
 * not inherit the focal affordances.
 *
 * Render surface is encoded as flags on `BlockContextType` set by every
 * non-document mount (`BlockEmbed`, `BacklinkEntry`, breadcrumb list).
 * The umbrella `isNestedSurface` is what this hook consults, so a new
 * surface only has to set the umbrella to be excluded automatically.
 */
export const useIsFocalRender = (block: Block): boolean => {
  const [topLevelBlockId] = useUIStateProperty(topLevelBlockIdProp)
  const {isNestedSurface} = useBlockContext()
  return block.id === topLevelBlockId && !isNestedSurface
}

/** Non-hook variant for facet contributions that receive a
 *  `BlockResolveContext`. Same policy as `useIsFocalRender`. */
export const isFocalRender = (ctx: BlockResolveContext): boolean =>
  ctx.isTopLevel && !ctx.blockContext?.isNestedSurface
