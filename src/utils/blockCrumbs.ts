/**
 * Crumb LABELS for a block's ancestor chain — the "where does this live?"
 * hint a search result carries so a bare line of content ("ship it") is
 * placeable without opening it.
 *
 * Text only, deliberately: the breadcrumbs plugin renders each crumb as a
 * real `BlockComponent` (markdown, block refs, the works), which is right
 * for one breadcrumb at the top of a panel and wrong for 25 rows of a
 * dropdown that repaints on every keystroke. These are plain strings
 * derived from already-loaded `BlockData`, so a crumb costs a `Map` lookup
 * and a text node.
 *
 * Content is taken verbatim (first line, whitespace collapsed) rather than
 * markdown-stripped — the same raw form the result rows themselves already
 * show, so a crumb never disagrees with the row it labels.
 */
import type { BlockData } from '@/data/api'
import { aliasesProp } from '@/data/properties.js'
import { labelForBlockData } from '@/utils/linkTargetAutocomplete.js'
import { firstLine, truncate, truncateMiddle } from '@/utils/string.js'

/** Longest a single crumb renders before it is ellipsised. Small on
 *  purpose: the whole chain shares one line, and a page title long enough
 *  to fill it would push every crumb after it out of view.
 *
 *  Named blocks are ellipsised from the MIDDLE at this width, because
 *  sibling titles collide constantly at the head — "Quarterly Planning
 *  Meeting Notes 2026" and its 2027 sibling both end-truncate to
 *  "Quarterly Planning Meet…", making two different rows read
 *  identically. That is the exact ambiguity the crumb was added to
 *  resolve, so the year has to survive. See `crumbLabel` for why prose
 *  ancestors are cut at the end instead. */
export const CRUMB_MAX_CHARS = 24

/** Most crumbs shown before the middle collapses to `…`.
 *
 *  The collapse keeps both ends, but only the ROOT is actually
 *  guaranteed to reach the screen, and the two limits are not the same
 *  thing: this one caps SEGMENTS, while the rendered line is capped by
 *  the WIDTH of its box, where a plain end-ellipsis clips whatever
 *  didn't fit. Measured at mobile width the crumb box is ~341px, a
 *  two-crumb line ~298px (fits) and a realistic four-crumb line ~455px
 *  (clipped) — so on a narrow screen a deep chain loses its tail no
 *  matter what this constant says.
 *
 *  That ordering is deliberate rather than tolerated. The root is the
 *  page, which is both the coarsest locator and usually the shortest
 *  string (a title, against middles that are whole block bodies) — and
 *  in practice it is the crumb that disambiguates, e.g. `Tutorial` vs
 *  `Tutorial (vim)` under an otherwise identical path. Letting the
 *  cheap end win is the right trade. */
export const CRUMB_MAX_SEGMENTS = 4

const CRUMB_ELLIPSIS = '…'

/** Whether this block has a real alias, i.e. whether `labelForBlockData`
 *  below will return a NAME rather than a line of body text. Mirrors that
 *  function's own filter (a raw properties-bag write can leave a
 *  non-array, or an array with blanks and non-strings in it) rather than
 *  going through `getAliases`, which throws on exactly those shapes. */
const hasAlias = (data: BlockData): boolean => {
  const aliases = data.properties[aliasesProp.name]
  return Array.isArray(aliases) &&
    aliases.some(alias => typeof alias === 'string' && alias.trim() !== '')
}

/** One crumb's text, or `''` for a block with nothing to say (a blank
 *  structural parent). Prefers the alias — a page's crumb should read
 *  "Project Alpha", not its first line of body text.
 *
 *  Where the ellipsis goes depends on which of those two it got, because
 *  the ends carry different weight in each. A NAME is distinguished by
 *  its tail far more often than its head — "…Meeting Notes 2026" vs the
 *  2027 sibling — so cutting the middle is what keeps two rows apart, and
 *  keeping two rows apart is the entire point of the crumb. PROSE has no
 *  such tail; its last few characters are wherever the sentence happened
 *  to be, so splicing them on reads as damage ("Fold a block…llet below.")
 *  and cutting the end is both honest and easier to read. */
const crumbLabel = (data: BlockData): string => {
  const label = firstLine(labelForBlockData(data, '')).replace(/\s+/g, ' ').trim()
  if (!label) return ''
  return hasAlias(data)
    ? truncateMiddle(label, CRUMB_MAX_CHARS)
    : truncate(label, CRUMB_MAX_CHARS)
}

/** Root→immediate-parent crumbs for one `core.manyAncestors` chain,
 *  ready to render.
 *
 *  The chain arrives leaf-to-root (depth ascending, self excluded), which
 *  is the reverse of reading order, hence the backwards walk.
 *
 *  Two kinds of ancestor are DROPPED rather than rendered:
 *   - blank ones. The crumb line is a locator hint, and
 *     `Project Alpha › › Notes` locates nothing `Project Alpha › Notes`
 *     doesn't.
 *   - property field rows (`isFieldForm`). Their content is literally
 *     `::((fieldId))`, and the rest of the app treats them as invisible
 *     machinery (see `VISIBLE_CHILD_PREDICATE_SQL`) — a crumb reading
 *     `Task Board › ::((field-def-status-00…` names no place a person
 *     could go. Their owner is further up the same chain and still shows.
 *
 *  A chain that does NOT reach a root is marked with a leading `…`
 *  instead of being presented as if its topmost surviving ancestor were
 *  the page. Two things cut a chain short, and both are silent in the
 *  data: the SQL filters `deleted = 0`, so a soft-deleted ancestor STOPS
 *  the upward walk (reachable via `core.restore`, which restores a single
 *  block and can leave a live child under a tombstoned parent, or via a
 *  child row arriving from sync while its parent is deleted locally); and
 *  the walk caps at `depth < 100`. Without the marker the user reads a
 *  confident, wrong location — the true page silently absent — which is
 *  worse than an obviously partial one. Leaving the workspace counts as a
 *  cut too: `manyAncestorsSql` carries no workspace predicate, and while
 *  `requireParentInWorkspace` blocks a cross-workspace parent edge on the
 *  write path, sync arrival applies `parent_id` verbatim with no
 *  re-validation — so this display-time consumer declines to render
 *  another workspace's content rather than trusting that invariant. */
export const crumbsFromAncestors = (
  ancestors: readonly BlockData[],
  {workspaceId, parentId}: {workspaceId: string; parentId: string | null},
): string[] => {
  const chain: BlockData[] = []
  for (const ancestor of ancestors) {
    if (ancestor.workspaceId !== workspaceId) break
    chain.push(ancestor)
  }

  const crumbs: string[] = []
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i].isFieldForm) continue
    const label = crumbLabel(chain[i])
    if (label) crumbs.push(label)
  }

  const highest = chain[chain.length - 1]
  // With no ancestors at all the array cannot answer whether the block is
  // a root or an orphan — both arrive as `[]` — so the block's OWN parent
  // edge decides. That case is not exotic: it is what a cut at the very
  // first hop looks like, i.e. exactly the `core.restore` scenario this
  // marker exists for, and the most likely one in practice.
  const reachesRoot = chain.length === ancestors.length &&
    (highest ? highest.parentId === null : parentId === null)
  // A cut chain has no root worth preserving, so the collapse that keeps
  // both ends doesn't apply — keep the nearest ancestors and let the
  // marker stand in for everything above them.
  return reachesRoot
    ? collapseCrumbs(crumbs)
    : [CRUMB_ELLIPSIS, ...crumbs.slice(-(CRUMB_MAX_SEGMENTS - 1))]
}

/** Collapse a long chain to `first › … › <tail>`, keeping the ends. */
export const collapseCrumbs = (crumbs: readonly string[]): string[] => {
  if (crumbs.length <= CRUMB_MAX_SEGMENTS) return [...crumbs]
  return [
    crumbs[0],
    CRUMB_ELLIPSIS,
    ...crumbs.slice(crumbs.length - (CRUMB_MAX_SEGMENTS - 2)),
  ]
}
