/**
 * "This block is a page" as a visual fact.
 *
 * A page in this app is just a block that carries an alias, so nothing about
 * where it appears tells you it is one. Zoomed in, every focal block renders
 * as the same 1.5rem heading, and a real named page is typographically
 * identical to a plain bullet you happened to zoom into. In the outline it is
 * worse: a page nested under something else looks exactly like ordinary text,
 * so you cannot tell which lines in a hierarchy are pages.
 *
 * Both cases are the same question — "does this carry a page name?" — so both
 * are answered here rather than in the renderer. Core reports the fact
 * (`ctx.aliases`) and takes no view on what it means; the alias plugin owns
 * the meaning, and disabling the plugin removes the styling with it.
 *
 * Two treatments, because the two contexts want different things:
 *   - focal: it IS the page title, so it earns the heading weight and a rule
 *     under it — `page-title-text`.
 *   - anywhere else: it is one line among many, so it only needs to be
 *     legible AS a page at a glance — `page-name-text`, a weight step, no
 *     size change. Making outline rows bigger would wreck the hierarchy's
 *     vertical rhythm, which is the thing that makes an outline readable.
 *
 * Inline `[[links]]` are deliberately untouched: those already render as
 * links, so they are not the case where page-ness is invisible.
 */
import { blockTextClassFacet } from '@/extensions/blockInteraction.js'
import type { BlockTextClassContribution } from '@/extensions/blockInteraction.js'

/** Rides `blockTextClassFacet`, NOT the content-surface facet, and that is the
 *  whole point: both treatments are typography, font-size/weight inherit, and
 *  the content slot holds whatever won the content-renderer facet. A page IS a
 *  block, so an aliased block can perfectly well render as a review deck or a
 *  Readwise backlog — styling the slot would push a 1.75rem/700 heading down
 *  into that entire surface. Carried by the text, it lands only on the block's
 *  own words.
 *
 *  Keyed on `ctx.aliases`, which the hook reads reactively — so naming or
 *  un-naming a block restyles it in place instead of freezing at whatever it
 *  was when the facet last resolved. */
export const aliasPageStyling: BlockTextClassContribution = ctx => {
  if (ctx.aliases.length === 0) return null
  return ctx.isFocal ? 'page-title-text' : 'page-name-text'
}

export const aliasPageStylingContribution = blockTextClassFacet.of(
  aliasPageStyling,
  {source: 'alias'},
)
