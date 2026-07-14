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
 *
 * KNOWN LIMITATION: `RawContent` renders the block's content renderer as-is.
 * `MarkdownContentRenderer` honours `inline` (drops to a span); a content
 * renderer with NO inline form renders its full UI inside the citation link.
 * This is not only the video player — every editor-style content renderer
 * (block-type / property-schema / types-page editors with their inputs and
 * pickers, the CodeMirror extension viewer) does too, i.e. form controls nested
 * in an `<a>` (invalid HTML; a click may navigate instead of edit). It's the
 * accepted "content renders wherever raw content lands" consequence — fixing it
 * would need a render-mode distinction, deliberately out of scope. Common refs
 * (plain text, image) are fine.
 */
const ReferenceLayout: BlockLayout = ({block, RawContent}: BlockLayoutSlots) => (
  <ReferenceLink block={block}>
    <RawContent/>
  </ReferenceLink>
)

/**
 * Self-gates on `isReference` (set by `BlockRef` via `RenderSurfaceProvider`).
 * The layout renders no `Children`, but `RawContent` is the block's markdown,
 * which CAN contain a nested `!((id))` embed; that embed clears `isReference`
 * (see `BlockEmbed`), so it renders as an embed rather than inheriting this
 * layout. A nested `((id))` reference sets `isReference` itself, which is correct.
 */
export const referenceLayoutContribution: BlockLayoutContribution = ctx => {
  if (!ctx.blockContext?.isReference) return null
  return {id: 'references.reference', label: 'Block reference', render: ReferenceLayout}
}
