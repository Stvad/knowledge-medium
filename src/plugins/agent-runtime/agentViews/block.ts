import type { Repo } from '@/data/repo'
import { AGENT_VIEW_DEFAULTS } from '@knowledge-medium/agent-cli/protocol'
import { BACKLINKS_FOR_BLOCK_QUERY } from '@/plugins/backlinks/query.js'
import { loadCrumbs, visibleChildCounts } from './context.ts'
import { createPropertyRenderer, type PropertyLine } from './properties.ts'
import { shortIds as loadShortIds } from './resolveRef.ts'
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
  /** The first {@link MAX_PROPERTIES}; `omittedProperties` counts the rest. */
  properties: PropertyLine[]
  omittedProperties: number
  /** The first {@link MAX_HIDDEN_NAMES} names; `hiddenPropertyCount` is all. */
  hiddenProperties: string[]
  hiddenPropertyCount: number
  childCount: number
  backlinkCount: number
  editedAt: string | null
}

const MAX_CHARS = 100_000
/** A property bag is bounded like content: an importer can write hundreds. */
const MAX_PROPERTIES = 50
const MAX_HIDDEN_NAMES = 20

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

  const [renderer, shortIds, crumbs, childCounts, backlinks] = await Promise.all([
    createPropertyRenderer(repo, [block]),
    loadShortIds(repo, [block.id]),
    loadCrumbs(repo, [block.id], block.workspaceId),
    visibleChildCounts(repo, [block.id]),
    // The backlinks view's own set, so the two counts cannot disagree.
    repo.query[BACKLINKS_FOR_BLOCK_QUERY]({workspaceId: block.workspaceId, id: block.id}).load(),
  ])
  const properties = renderer.view(block, 'full')
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
    properties: properties.visible.slice(0, MAX_PROPERTIES),
    omittedProperties: Math.max(0, properties.visible.length - MAX_PROPERTIES),
    hiddenProperties: properties.hidden.slice(0, MAX_HIDDEN_NAMES),
    hiddenPropertyCount: properties.hidden.length,
    childCount: childCounts.get(block.id) ?? 0,
    backlinkCount: backlinks.length,
    editedAt: typeof editedAt === 'number' ? new Date(editedAt).toISOString() : null,
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
  lines.push(`^${view.shortId}  (${view.id})  ${facts.join(' · ')}`)
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
      `(+${formatCount(view.omittedProperties)} more properties — sql_query: SELECT key, value FROM blocks, `
      + `json_each(blocks.properties_json) WHERE blocks.id = '${view.id}')`,
    )
  }
  if (view.hiddenPropertyCount > 0) {
    const rest = view.hiddenPropertyCount - view.hiddenProperties.length
    lines.push(`(hidden in the UI: ${view.hiddenProperties.join(', ')}${rest > 0 ? `, +${formatCount(rest)} more` : ''})`)
  }
  return joinDisplayLines(lines)
}
