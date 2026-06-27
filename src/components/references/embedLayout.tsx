import type {
  BlockLayout,
  BlockLayoutContribution,
  BlockLayoutSlots,
} from '@/extensions/blockInteraction.js'
import { DefaultBlockLayout } from '@/components/renderer/DefaultBlockRenderer.js'

/**
 * Layout for the root of a block embed (`!((id))`). It wraps the block's
 * normal (default) layout — content, children, bullet, collapse, properties,
 * everything — in the highlighted box that used to live in `BlockEmbed`.
 * Delegating to `DefaultBlockLayout` keeps the embedded subtree pixel-identical
 * to the pre-refactor rendering; only the surrounding box moved here.
 */
const EmbedLayout: BlockLayout = (slots: BlockLayoutSlots) => (
  <div className="blockembed border-l-2 border-muted pl-2 my-1 bg-muted/30 rounded-r">
    <DefaultBlockLayout {...slots}/>
  </div>
)

/**
 * Self-gates on `isEmbedded` AND the embed root. `isEmbedded` propagates down
 * the embedded subtree via context, so without the `scopeRootId` check every
 * descendant would also get boxed; restricting to `block.id === scopeRootId`
 * (the embed sets `scopeRootId` to the embedded block) keeps the box on the
 * root only, with descendants falling through to the default layout.
 */
export const embedLayoutContribution: BlockLayoutContribution = ctx => {
  if (!ctx.blockContext?.isEmbedded) return null
  if (ctx.block.id !== ctx.scopeRootId) return null
  return {id: 'references.embed', label: 'Block embed', render: EmbedLayout}
}
