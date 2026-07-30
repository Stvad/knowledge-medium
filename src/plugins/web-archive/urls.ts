/**
 * Pull link targets out of a block's markdown content.
 *
 * Parsed, not regexed: the app renders block content through remark + GFM, so
 * parsing with the same grammar is the only way "what the user sees as a
 * link" and "what we submit to an archive" stay the same set. A regex would
 * also happily match inside a fenced code block — publishing a URL the user
 * was quoting, not visiting.
 *
 * Only `link` and `definition` nodes are collected. Images are excluded: an
 * image URL is an asset the page embeds, not a page the user linked to, and
 * archiving assets is both noisy and a different feature.
 */

import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'
import type { Root } from 'mdast'

const parser = unified().use(remarkParse).use(remarkGfm)

/** Unique link targets in document order, exactly as written. Normalization
 *  and public/private filtering are `hostPolicy.ts`'s job — this stays a
 *  parser so the two can be tested independently. */
export const extractLinkTargets = (content: string): string[] => {
  if (!content.trim()) return []

  let tree: Root
  try {
    tree = parser.parse(content)
  } catch {
    // A block mid-edit can hold anything. A parse failure means "no links
    // I can vouch for", never "guess with a regex".
    return []
  }

  const seen = new Set<string>()
  const out: string[] = []
  visit(tree, ['link', 'definition'], node => {
    const url = (node as {url?: unknown}).url
    if (typeof url !== 'string') return
    const trimmed = url.trim()
    if (!trimmed || seen.has(trimmed)) return
    seen.add(trimmed)
    out.push(trimmed)
  })
  return out
}
