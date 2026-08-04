import type { Block } from '@/data/block.js'
import { useIsFocalRender } from '@/hooks/useIsFocalRender.js'
import { useBlockAliases } from '@/hooks/block.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { blockTextClassFacet } from '@/extensions/blockInteraction.js'

/** Title typography (1.5rem/600) for the focal block's own text.
 *
 *  It is applied by the renderers that DRAW that text — the markdown read
 *  renderer and the CodeMirror editor — rather than by the content slot that
 *  contains them, and that placement is the whole point.
 *
 *  font-size, font-weight and line-height all INHERIT. Put them on the slot and
 *  you have not said "the title is big", you have said "everything mounted at
 *  top of panel is big" — and the slot's occupant is whatever won
 *  `blockContentRendererFacet`: a review deck, a recents list, a video player,
 *  the Readwise backlog. That is how every backlog highlight came to render as
 *  a heading (24px/600 where the same block reads 16px/400 anywhere else): the
 *  page's own chrome set explicit sizes, but the block bodies it embeds don't.
 *
 *  Inferring the answer at the slot is not a fix, it's the same mistake with a
 *  heuristic bolted on. "Did the caller pass a ContentRenderer?" is wrong in
 *  BOTH directions — the recents page passes one and renders a real title
 *  through it, while a facet-supplied renderer passes no prop at all — and any
 *  replacement signal (a static on the component, an opt-out prop) still asks
 *  every renderer author to answer a question about a class they don't apply.
 *
 *  Carried by the text, none of that arises. Render the block's text and the
 *  title styling comes with it; render something else and it doesn't. A surface
 *  that wants a title composes `MarkdownContentRenderer` (as the recents page
 *  does) and gets one, with nothing to declare.
 *
 *  Focality — not `isTopLevel` alone — is the gate, so an embed or a backlink
 *  entry showing the focal block doesn't pick up a title. See
 *  `useIsFocalRender`. */
export const BLOCK_TITLE_TEXT_CLASS = 'block-title-text'

/** Every class this render of `block` puts on its own text: the focal title
 *  class, plus whatever plugins contribute through `blockTextClassFacet`
 *  (the alias plugin marks pages here). `''` when there is nothing to add —
 *  shaped for `clsx`-free className concatenation.
 *
 *  Plugin text styling comes through this one seam for the reason above: a
 *  plugin that wanted to make page titles bigger would otherwise reach for
 *  the content-surface facet and re-create the inheritance bug.
 *
 *  `aliases` is read HERE, reactively, and passed down — a facet contribution
 *  can't call hooks, and reading `block.peek()` inside one would freeze at
 *  resolve time, so renaming a block wouldn't restyle it. */
export const useBlockTitleTextClass = (block: Block): string => {
  const isFocal = useIsFocalRender(block)
  const aliases = useBlockAliases(block)
  const runtime = useAppRuntime()
  const resolveTextClasses = runtime.read(blockTextClassFacet)
  const contributed = resolveTextClasses({block, isFocal, aliases})
  return [isFocal ? BLOCK_TITLE_TEXT_CLASS : '', contributed].filter(Boolean).join(' ')
}
