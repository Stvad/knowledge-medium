import type { Repo } from '@/data/repo'
import { AGENT_VIEW_DEFAULTS } from '@knowledge-medium/agent-cli/protocol'
import { BACKLINKS_COUNT_FOR_BLOCK_QUERY } from '@/plugins/backlinks/inline-counts/countQuery.js'
import { loadCrumbs, visibleChildCounts } from './context.ts'
import { createPropertyRenderer, type PropertyLine } from './properties.ts'
import { boundDisplayId, displayIds } from './displayIds.ts'
import { crumbLine, joinDisplayLines, loadRoot, plural } from './shared.ts'
import { charBoundary, formatCount } from './text.ts'

export interface BlockViewParams {
  ref: string
  maxChars?: number
  contentOffset?: number
}

export interface BlockView {
  id: string
  shortId: string
  workspaceId: string
  parentId: string | null
  breadcrumb: string[]
  types: string[]
  /** `content.slice(contentOffset, contentOffset + maxChars)`, verbatim
   *  (line breaks kept — this is the one view meant for reading a block whole). */
  content: string
  contentOffset: number
  contentLength: number
  /** Where to continue reading, or null when `content` reaches the end. */
  nextContentOffset: number | null
  /** Bounded by the property renderer; `omittedProperties` counts the rest. */
  properties: PropertyLine[]
  omittedProperties: number
  /** Bounded names, ending in `+N more` when cut. */
  hiddenProperties: string[]
  childCount: number
  backlinkCount: number
  editedAt: string | null
}

const MAX_CHARS = 100_000

/** Sync admits out-of-range timestamps, and one must not take the view down. */
const validIso = (ms: unknown): string | null => {
  if (typeof ms !== 'number') return null
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export const buildBlockView = async (
  repo: Repo,
  workspaceId: string,
  params: BlockViewParams,
): Promise<BlockView> => {
  const {root: block} = await loadRoot(repo, params.ref, workspaceId, async id => await repo.load(id) ?? undefined)
  const maxChars = Math.min(params.maxChars ?? AGENT_VIEW_DEFAULTS.blockMaxChars, MAX_CHARS)
  const contentOffset = charBoundary(block.content, Math.min(params.contentOffset ?? 0, block.content.length))
  // A page always advances: a one-char page that would split a pair takes both halves.
  const boundary = charBoundary(block.content, Math.min(block.content.length, contentOffset + maxChars))
  const end = boundary > contentOffset ? boundary : Math.min(block.content.length, contentOffset + 2)

  const [renderer, shortIds, crumbs, childCounts, backlinkCount] = await Promise.all([
    createPropertyRenderer(repo, [block], 'full'),
    displayIds(repo, [block.id]),
    loadCrumbs(repo, [block.id], block.workspaceId),
    visibleChildCounts(repo, [block.id], workspaceId),
    // The count of the backlinks view's own set, which owns that equality;
    // it aggregates in SQL where it can, never listing the sources.
    repo.query[BACKLINKS_COUNT_FOR_BLOCK_QUERY]({workspaceId: block.workspaceId, id: block.id}).load(),
  ])
  const properties = renderer.view(block)
  const editedAt = block.userUpdatedAt ?? block.updatedAt

  return {
    id: block.id,
    shortId: shortIds.get(block.id) ?? block.id,
    workspaceId: block.workspaceId,
    parentId: block.parentId,
    breadcrumb: crumbs.get(block.id) ?? [],
    types: renderer.typeLabels(block),
    content: block.content.slice(contentOffset, end),
    contentOffset,
    contentLength: block.content.length,
    nextContentOffset: end < block.content.length ? end : null,
    properties: properties.visible,
    omittedProperties: properties.omitted,
    hiddenProperties: properties.hidden,
    childCount: childCounts.get(block.id) ?? 0,
    backlinkCount,
    editedAt: validIso(editedAt),
  }
}

export const renderBlockView = (view: BlockView): string => {
  const lines: string[] = []
  const facts = [
    view.types.length > 0 ? `type:: ${view.types.join(', ')}` : null,
    plural(view.childCount, 'child', 'children'),
    plural(view.backlinkCount, 'backlink'),
    view.editedAt ? `edited ${view.editedAt.slice(0, 10)}` : null,
  ].filter(Boolean)
  lines.push(`^${view.shortId}  (${boundDisplayId(view.id)})  ${facts.join(' · ')}`)
  lines.push(`in: ${crumbLine(view.breadcrumb)}`)
  lines.push('')
  if (view.contentOffset > 0) lines.push(`…[${formatCount(view.contentOffset)} chars before]`)
  for (const line of view.content.split(/\r?\n/)) lines.push(line)
  if (view.nextContentOffset !== null) {
    const rest = view.contentLength - view.nextContentOffset
    lines.push(`…[+${formatCount(rest)} chars — continue with contentOffset=${view.nextContentOffset}]`)
  }
  if (view.properties.length > 0) {
    lines.push('')
    for (const property of view.properties) lines.push(`${property.name}:: ${property.value}`)
  }
  if (view.omittedProperties > 0) {
    lines.push(
      // The id goes in params, never the SQL text: a synced id is not
      // guaranteed free of quotes.
      `(+${formatCount(view.omittedProperties)} more properties — sql_query: SELECT key, value FROM blocks, `
      + `json_each(blocks.properties_json) WHERE blocks.id = ? with params `
      + `${boundDisplayId(view.id) === view.id ? JSON.stringify([view.id]) : '[this block\'s id from format: "json"]'})`,
    )
  }
  if (view.hiddenProperties.length > 0) {
    lines.push(`(hidden in the UI: ${view.hiddenProperties.join(', ')})`)
  }
  return joinDisplayLines(lines)
}
