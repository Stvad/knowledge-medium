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
import { labelForBlockData } from '@/utils/linkTargetAutocomplete.js'
import { truncate } from '@/utils/string.js'

/** Longest a single crumb renders before it is ellipsised. Small on
 *  purpose: the whole chain shares one line, and a page title long enough
 *  to fill it would push every crumb after it out of view. */
export const CRUMB_MAX_CHARS = 24

/** Most crumbs shown before the middle collapses to `…`. The two that
 *  carry the locating information are the ROOT (which page) and the
 *  IMMEDIATE PARENT (which section), so those are the ones the collapse
 *  keeps. Must be >= 3 (first + `…` + at least one tail crumb); smaller
 *  values are clamped. */
export const CRUMB_MAX_SEGMENTS = 4

const CRUMB_ELLIPSIS = '…'

const firstLine = (value: string): string => value.match(/^[^\r\n]*/)?.[0] ?? ''

/** One crumb's text, or `''` for a block with nothing to say (a blank
 *  structural parent). Prefers the alias — a page's crumb should read
 *  "Project Alpha", not its first line of body text. */
const crumbLabel = (data: BlockData): string => {
  const label = firstLine(labelForBlockData(data, '')).replace(/\s+/g, ' ').trim()
  return label ? truncate(label, CRUMB_MAX_CHARS) : ''
}

/** Root→immediate-parent crumbs for one `core.manyAncestors` chain.
 *
 *  The chain arrives leaf-to-root (depth ascending, self excluded), which
 *  is the reverse of reading order, hence the backwards walk.
 *
 *  Blank ancestors are DROPPED rather than rendered as an empty segment:
 *  the crumb line is a locator hint, and `Project Alpha › › Notes` locates
 *  nothing that `Project Alpha › Notes` doesn't. */
export const crumbsFromAncestors = (ancestors: readonly BlockData[]): string[] => {
  const crumbs: string[] = []
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const label = crumbLabel(ancestors[i])
    if (label) crumbs.push(label)
  }
  return crumbs
}

/** Collapse a long chain to `first › … › <tail>`, keeping the ends. */
export const collapseCrumbs = (
  crumbs: readonly string[],
  maxSegments: number = CRUMB_MAX_SEGMENTS,
): string[] => {
  const max = Math.max(maxSegments, 3)
  if (crumbs.length <= max) return [...crumbs]
  return [crumbs[0], CRUMB_ELLIPSIS, ...crumbs.slice(crumbs.length - (max - 2))]
}
