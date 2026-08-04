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
 *     under it — `page-title-content`.
 *   - anywhere else: it is one line among many, so it only needs to be
 *     legible AS a page at a glance — `page-name-content`, a weight step, no
 *     size change. Making outline rows bigger would wreck the hierarchy's
 *     vertical rhythm, which is the thing that makes an outline readable.
 *
 * Inline `[[links]]` are deliberately untouched: those already render as
 * links, so they are not the case where page-ness is invisible.
 */
import { blockContentSurfacePropsFacet } from '@/extensions/blockInteraction.js'
import type { BlockContentSurfaceContribution } from '@/extensions/blockInteraction.js'
import { isFocalRender } from '@/hooks/useIsFocalRender.js'

/** Keyed on `ctx.aliases`, which the renderer feeds reactively (like
 *  `ctx.types`) — so naming or un-naming a block restyles it in place
 *  instead of freezing at whatever it was when the facet last resolved. */
export const aliasPageStyling: BlockContentSurfaceContribution = ctx => {
  if (ctx.aliases.length === 0) return null
  return {className: isFocalRender(ctx) ? 'page-title-content' : 'page-name-content'}
}

export const aliasPageStylingContribution = blockContentSurfacePropsFacet.of(
  aliasPageStyling,
  {source: 'alias'},
)
