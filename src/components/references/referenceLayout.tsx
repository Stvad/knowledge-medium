import type {
  BlockLayout,
  BlockLayoutContribution,
  BlockLayoutSlots,
} from '@/extensions/blockInteraction.js'
import { ReferenceLink } from './ReferenceLink.tsx'

/**
 * Layout for a block rendered as an inline reference (`((id))`). A reference
 * IS the same block, rendered with a layout that picks the *raw content* —
 * raw-content-as-an-inline-citation is the semantics of a reference. The
 * navigating link wraps `RawContent` (the block's base read renderer, inline
 * and chrome-free), so a media block's image, a text block's markdown, etc.
 * all render through the one block-rendering pipeline.
 *
 * Crucially the reference layout renders NEITHER the editable content surface
 * (`Content`) NOR `Children` — only the inline raw content. It therefore
 * attaches no shell/paste/gesture handlers and can never become an editor.
 */
const ReferenceLayout: BlockLayout = ({block, RawContent}: BlockLayoutSlots) => (
  <ReferenceLink block={block}>
    <RawContent/>
  </ReferenceLink>
)

/**
 * Self-gates on `isReference` (set by `BlockRef` via `NestedBlockContextProvider`).
 * The reference layout renders no children, so `isReference` never propagates
 * through rendered descendants — gating on the flag alone is sufficient.
 */
export const referenceLayoutContribution: BlockLayoutContribution = ctx => {
  if (!ctx.blockContext?.isReference) return null
  return {id: 'references.reference', label: 'Block reference', render: ReferenceLayout}
}
