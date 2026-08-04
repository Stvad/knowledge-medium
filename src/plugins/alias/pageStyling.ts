/**
 * "This block is a page" as a visual fact.
 *
 * A page in this app is just a block that carries an alias, so nothing about
 * where it appears tells you it is one. Nested in an outline a page looks
 * exactly like ordinary text, so you cannot tell which lines in a hierarchy
 * are pages. Core reports the fact (`ctx.aliases`) and takes no view on what
 * it means; the alias plugin owns the meaning, and disabling the plugin
 * removes the styling with it.
 *
 * Only the non-focal case is styled, and the focal one is a deliberate
 * omission rather than an oversight. The open page's title carried a size
 * step plus a hairline rule for a while; it was removed because:
 *   - a line under text is already spoken for, twice. Solid means link and
 *     dotted means block reference (`index.css`), so a third line-under-text
 *     for "page" overloads a channel that is full — and refs sit inside
 *     titles, where the two meet.
 *   - a rule under a heading is the most generic decoration in typography. It
 *     says "section break", which is what an H1 gets everywhere; it does not
 *     distinguish a page from a big block.
 *   - it fired where it was least needed. At the title the breadcrumb, the
 *     panel chrome and the navigation that got you there already answer the
 *     question; the ambiguous case is the outline row.
 *   - its geometry was decided elsewhere. The rule sat on the title text
 *     container, whose width comes from whatever wraps it — with type chips
 *     visible `TypeChipsDecorator` makes that a shrink-to-fit flex item, so
 *     the rule stopped at the last character; without chips it spanned the
 *     panel. Same page, two rules, chosen by whether you had tagged it.
 *
 * Inline `[[links]]` are deliberately untouched: those already render as
 * links, so they are not the case where page-ness is invisible.
 */
import { blockTextClassFacet } from '@/extensions/blockInteraction.js'
import type { BlockTextClassContribution } from '@/extensions/blockInteraction.js'

/** Rides `blockTextClassFacet`, NOT the content-surface facet, and that is the
 *  whole point: the treatment is typography, font-size/weight inherit, and
 *  the content slot holds whatever won the content-renderer facet. A page IS a
 *  block, so an aliased block can perfectly well render as a review deck or a
 *  Readwise backlog — styling the slot would push the weight step down into
 *  that entire surface. Carried by the text, it lands only on the block's
 *  own words.
 *
 *  Weight-only, and no size change: these rows sit among siblings, and
 *  resizing them would break the vertical rhythm that makes an outline
 *  scannable. The goal is "I can tell that line is a page", not "that line is
 *  a heading".
 *
 *  Keyed on `ctx.aliases`, which the hook reads reactively — so naming or
 *  un-naming a block restyles it in place instead of freezing at whatever it
 *  was when the facet last resolved. */
export const aliasPageStyling: BlockTextClassContribution = ctx => {
  if (ctx.isFocal || ctx.aliases.length === 0) return null
  return 'page-name-text'
}

export const aliasPageStylingContribution = blockTextClassFacet.of(
  aliasPageStyling,
  {source: 'alias'},
)
