import type { Repo } from '@/data/repo'
import type { BlockData } from '@/data/api'
import { AGENT_VIEW_DEFAULTS } from '@knowledge-medium/agent-cli/protocol'
import { BACKLINKS_FOR_BLOCK_QUERY, type BacklinksFilter } from '@/plugins/backlinks/query.js'
import { resolveBacklinksFilter, type BacklinksFilterSpec } from '@/plugins/backlinks/resolveFilter.js'
import {
  GROUPED_BACKLINKS_FOR_BLOCK_QUERY,
  type GroupedBacklinksResult,
} from '@/plugins/grouped-backlinks/query.js'
import {
  resolveGroupedBacklinksConfig,
  type GroupedBacklinksGroupingSpec,
} from '@/plugins/grouped-backlinks/resolveConfig.js'
import { labelForBlockData } from '@/utils/linkTargetAutocomplete.js'
import { firstVisibleChildren, loadBlocks, loadCrumbs, visibleChildCounts } from './context.ts'
import { createPropertyRenderer } from './properties.ts'
import { shortIds as loadShortIds } from './resolveRef.ts'
import { clampInt, CUT_LEGEND, crumbLine, joinDisplayLines, loadRoot, metaSuffix, plural, toViewRow, type ViewRow } from './shared.ts'
import { clipLine, formatCount, isReferenceOnly } from './text.ts'

const MAX_BACKLINKS = 500
const MAX_GROUPS = 200
const ROW_CHARS = 240
const CONTEXT_CHARS = 160
const TITLE_CHARS = 120

interface Target {
  id: string
  shortId: string
  title: string
}

export interface BacklinkRow extends ViewRow {
  breadcrumb: string[]
  childCount: number
  /** Property names it references the target through; empty for a link in
   *  its text. */
  viaProperties: string[]
  /** Only for a block that is nothing but links. */
  parentContent?: string
  firstChildContent?: string
}

export interface BacklinksView {
  target: Target
  total: number
  offset: number
  nextOffset: number | null
  filter: BacklinksFilter | null
  rows: BacklinkRow[]
}

const SOURCE_FIELDS_FOR_SOURCES_SQL = `
  SELECT DISTINCT r.source_id AS source_id, r.source_field AS source_field
    FROM json_each(?) j
    JOIN block_references r ON r.source_id = j.value
   WHERE r.workspace_id = ? AND r.target_id = ?
`

const viaPropertiesBySource = async (
  repo: Repo,
  workspaceId: string,
  targetId: string,
  sourceIds: readonly string[],
): Promise<Map<string, string[]>> => {
  const rows = await repo.db.getAll<{source_id: string, source_field: string}>(
    SOURCE_FIELDS_FOR_SOURCES_SQL,
    [JSON.stringify(sourceIds), workspaceId, targetId],
  )
  const out = new Map<string, string[]>()
  for (const row of rows) {
    if (row.source_field === '') continue
    out.set(row.source_id, [...(out.get(row.source_id) ?? []), row.source_field].sort())
  }
  return out
}

const loadTarget = async (repo: Repo, ref: string, workspaceId: string): Promise<{block: BlockData, target: Target}> => {
  const {root} = await loadRoot(repo, ref, workspaceId, async id => (await loadBlocks(repo, [id]))[0])
  const shortIds = await loadShortIds(repo, [root.id])
  const title = labelForBlockData(root, root.id)
  return {
    block: root,
    target: {id: root.id, shortId: shortIds.get(root.id) ?? root.id, title: clipLine(title, TITLE_CHARS).text},
  }
}

/** Context rows for a page of backlink sources: breadcrumb, child count, and
 *  — for a block that only links — its parent's text and first child. */
const backlinkRows = async (
  repo: Repo,
  workspaceId: string,
  targetId: string,
  sources: readonly BlockData[],
): Promise<BacklinkRow[]> => {
  const ids = sources.map(source => source.id)
  const linkOnly = sources.filter(source => isReferenceOnly(source.content))
  const parentIds = [...new Set(linkOnly.map(source => source.parentId).filter((id): id is string => id !== null))]
  const [renderer, shortIds, crumbs, childCounts, via, parents, firstChildren] = await Promise.all([
    createPropertyRenderer(repo, sources),
    loadShortIds(repo, ids),
    loadCrumbs(repo, ids, workspaceId),
    visibleChildCounts(repo, ids),
    viaPropertiesBySource(repo, workspaceId, targetId, ids),
    loadBlocks(repo, parentIds),
    firstVisibleChildren(repo, linkOnly.map(source => source.id)),
  ])
  const parentById = new Map(parents.map(parent => [parent.id, parent]))
  return sources.map(source => {
    const row: BacklinkRow = {
      ...toViewRow(source, {shortIds, renderer, maxChars: ROW_CHARS, detail: 'brief'}),
      breadcrumb: crumbs.get(source.id) ?? [],
      childCount: childCounts.get(source.id) ?? 0,
      viaProperties: via.get(source.id) ?? [],
    }
    if (isReferenceOnly(source.content)) {
      const parent = source.parentId ? parentById.get(source.parentId) : undefined
      if (parent && parent.content.trim()) row.parentContent = clipLine(parent.content, CONTEXT_CHARS).text
      const child = firstChildren.get(source.id)
      if (child && child.content.trim()) row.firstChildContent = clipLine(child.content, CONTEXT_CHARS).text
    }
    return row
  })
}

export interface BacklinksParams {
  ref: string
  limit?: number
  offset?: number
  filter?: BacklinksFilterSpec
}

export const buildBacklinksView = async (
  repo: Repo,
  workspaceId: string,
  params: BacklinksParams,
): Promise<BacklinksView> => {
  const limit = clampInt(params.limit, AGENT_VIEW_DEFAULTS.backlinksLimit, MAX_BACKLINKS)
  const offset = params.offset ?? 0
  const {block, target} = await loadTarget(repo, params.ref, workspaceId)
  const filter = await resolveBacklinksFilter(repo, block.workspaceId, block.id, params.filter)
  const ids = await repo.query[BACKLINKS_FOR_BLOCK_QUERY]({
    workspaceId: block.workspaceId,
    id: block.id,
    ...(filter ? {filter} : {}),
  }).load()
  const page = ids.slice(offset, offset + limit)
  const sources = await loadBlocks(repo, page)
  const end = offset + page.length
  return {
    target,
    total: ids.length,
    offset,
    nextOffset: end < ids.length ? end : null,
    filter: filter ?? null,
    rows: await backlinkRows(repo, block.workspaceId, block.id, sources),
  }
}

/** A row's location, for spotting runs of siblings: many backlinks in one
 *  place (a page's worth of `[[Topic]]` bullets) share it, and repeating it
 *  per row is the noise this view exists to remove. */
const placeOf = (row: BacklinkRow): string =>
  JSON.stringify([row.breadcrumb, row.parentContent ?? null])

const renderBacklinkRow = (row: BacklinkRow, index: number, samePlace: boolean): string[] => {
  const via = row.viaProperties.length > 0 ? `  [via ${row.viaProperties.join(', ')}]` : ''
  const children = row.childCount > 0 ? `  (${plural(row.childCount, 'child', 'children')})` : ''
  const body = `${row.content}${metaSuffix(row, 'brief')}${children}`
  const firstChild = row.firstChildContent ? `   ↳ first child: ${row.firstChildContent}` : null
  if (samePlace) {
    return [`${index}. ^${row.shortId}  (same place as above)${via}  ${body}`, ...(firstChild ? [firstChild] : [])]
  }
  const lines = [`${index}. ^${row.shortId}  ${crumbLine(row.breadcrumb)}${via}`, `   ${body}`]
  if (row.parentContent) lines.push(`   ↳ parent: ${row.parentContent}`)
  if (firstChild) lines.push(firstChild)
  return lines
}

const rangeNote = (offset: number, shown: number, total: number, nextOffset: number | null): string => {
  if (shown === 0) return offset > 0 ? `none past offset ${formatCount(offset)} of ${formatCount(total)}` : 'none'
  const range = `${formatCount(offset + 1)}–${formatCount(offset + shown)} of ${formatCount(total)}`
  return nextOffset === null ? range : `${range} (next: offset=${nextOffset})`
}

export const renderBacklinksView = (view: BacklinksView): string => {
  const lines = [
    `Backlinks of "${view.target.title}" ^${view.target.shortId} — ${rangeNote(view.offset, view.rows.length, view.total, view.nextOffset)}`,
  ]
  view.rows.forEach((row, index) => {
    const samePlace = index > 0 && placeOf(row) === placeOf(view.rows[index - 1])
    lines.push(...renderBacklinkRow(row, view.offset + index + 1, samePlace))
  })
  if (view.rows.some(row => row.cut > 0)) lines.push(CUT_LEGEND)
  return joinDisplayLines(lines)
}

// ----- grouped -----

export interface GroupedBacklinksParams extends BacklinksParams {
  membersPerGroup?: number
  grouping?: GroupedBacklinksGroupingSpec
}

export interface BacklinkGroup {
  label: string
  /** The group's page/block when it is one (the `Other` fallback is not). */
  groupId: string | null
  shortId: string | null
  fallback: boolean
  memberCount: number
  members: ViewRow[]
}

export interface GroupedBacklinksView {
  target: Target
  total: number
  groupCount: number
  offset: number
  nextOffset: number | null
  groups: BacklinkGroup[]
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const buildGroupedBacklinksView = async (
  repo: Repo,
  workspaceId: string,
  params: GroupedBacklinksParams,
): Promise<GroupedBacklinksView> => {
  const limit = clampInt(params.limit, AGENT_VIEW_DEFAULTS.groupsLimit, MAX_GROUPS)
  const membersPerGroup = clampInt(params.membersPerGroup, AGENT_VIEW_DEFAULTS.membersPerGroup, MAX_BACKLINKS)
  const offset = params.offset ?? 0
  const {block, target} = await loadTarget(repo, params.ref, workspaceId)
  const filter = await resolveBacklinksFilter(repo, block.workspaceId, block.id, params.filter)
  const grouping = await resolveGroupedBacklinksConfig(repo, block.workspaceId, block.id, params.grouping)
  const result = await repo.query[GROUPED_BACKLINKS_FOR_BLOCK_QUERY]({
    workspaceId: block.workspaceId,
    id: block.id,
    groupingConfig: grouping,
    ...(filter ? {filter} : {}),
  }).load() as GroupedBacklinksResult

  const page = result.groups.slice(offset, offset + limit)
  const memberIds = [...new Set(page.flatMap(group => group.sourceIds.slice(0, membersPerGroup)))]
  const groupIds = page.map(group => group.groupId).filter(id => UUID_RE.test(id))
  const members = await loadBlocks(repo, memberIds)
  const [renderer, shortIds] = await Promise.all([
    createPropertyRenderer(repo, members),
    loadShortIds(repo, [...memberIds, ...groupIds]),
  ])
  const memberById = new Map(members.map(member => [member.id, member]))
  const end = offset + page.length

  return {
    target,
    total: result.total,
    groupCount: result.groups.length,
    offset,
    nextOffset: end < result.groups.length ? end : null,
    groups: page.map(group => {
      const isBlock = UUID_RE.test(group.groupId)
      return {
        label: clipLine(group.label, TITLE_CHARS).text,
        groupId: isBlock ? group.groupId : null,
        shortId: isBlock ? shortIds.get(group.groupId) ?? group.groupId : null,
        fallback: group.fallback,
        memberCount: group.sourceIds.length,
        members: group.sourceIds
          .slice(0, membersPerGroup)
          .flatMap(id => {
            const member = memberById.get(id)
            return member ? [toViewRow(member, {shortIds, renderer, maxChars: ROW_CHARS, detail: 'brief'})] : []
          }),
      }
    }),
  }
}

export const renderGroupedBacklinksView = (view: GroupedBacklinksView): string => {
  const lines = [
    `Grouped backlinks of "${view.target.title}" ^${view.target.shortId} — ${plural(view.total, 'backlink')} in ${plural(view.groupCount, 'group')}; groups ${rangeNote(view.offset, view.groups.length, view.groupCount, view.nextOffset)}`,
  ]
  view.groups.forEach((group, index) => {
    const id = group.shortId ? `  ^${group.shortId}` : ''
    lines.push(`## ${group.label}${id}  (${formatCount(group.memberCount)})`)
    for (const member of group.members) lines.push(`- ${member.content}${metaSuffix(member, 'brief')}  ^${member.shortId}`)
    const rest = group.memberCount - group.members.length
    if (rest > 0) {
      const wanted = Math.min(group.memberCount, MAX_BACKLINKS)
      lines.push(`  +${formatCount(rest)} more — membersPerGroup=${wanted} offset=${view.offset + index} limit=1 lists ${wanted === group.memberCount ? 'them' : `the first ${formatCount(wanted)}`}`)
    }
  })
  if (view.groups.some(group => group.members.some(member => member.cut > 0))) lines.push(CUT_LEGEND)
  return joinDisplayLines(lines)
}
