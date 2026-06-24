import { isFocalRender } from '@/hooks/useIsFocalRender.js'
import type { BlockResolveContext } from '@/extensions/blockInteraction.js'

/** Inline backlink affordances (the count badge + click-to-expand) attach
 *  to ordinary outline blocks only:
 *
 *    - never the focal block — its full Linked References already render
 *      below it via the backlinks-view footer; a badge there would duplicate
 *      that affordance.
 *    - never inside a nested surface (embed, backlink entry, breadcrumb) —
 *      a recursive count badge on every embedded bullet is noise, and the
 *      backlinks list itself is rendered through nested surfaces.
 *
 *  `isFocalRender` already folds in the nested-surface check for the focal
 *  id, but a *non-focal* block inside a nested surface still needs the
 *  explicit guard. */
export const inlineBacklinksApplies = (ctx: BlockResolveContext): boolean =>
  !isFocalRender(ctx) && !ctx.blockContext?.isNestedSurface
