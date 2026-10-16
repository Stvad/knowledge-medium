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
import { createPropertyRenderer, NAME_CHARS } from './properties.ts'
import { clampInt, CUT_LEGEND, crumbLine, displayIds, joinDisplayLines, loadRoot, metaSuffix, plural, toViewRow, type ViewRow } from './shared.ts'
import { boundLabels, clipLine, formatCount, isReferenceOnly } from './text.ts'

const MAX_BACKLINKS = 500
const MAX_GROUPS = 200
const ROW_CHARS = 240
const CONTEXT_CHARS = 160
const TITLE_CHARS = 120
const MAX_VIA = 5

interface Target {
  id: string
  shortId: string
  title: string
}

export interface BacklinkRow extends ViewRow {
  /** 1-based position in the backlink listing, counting ids consumed even
   *  when their block was deleted before it could be read. */
  position: number
  parentId: string | null
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

/** The first few property names each source references the target through,
 *  plus how many there are — windowed in SQL, so a source with thousands
 *  of ref fields costs its shown few. */
const SOURCE_FIELDS_FOR_SOURCES_SQL = `
  SELECT source_id, source_field, n FROM (
    SELECT source_id, source_field,
           ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY source_field) AS rn,
           COUNT(*) OVER (PARTITION BY source_id) AS n
      FROM (SELECT DISTINCT r.source_id AS source_id, r.source_field AS source_field
              FROM json_each(?) j
              JOIN block_references r ON r.source_id = j.value
             WHERE r.workspace_id = ? AND r.target_id = ? AND r.source_field != '')
  ) WHERE rn <= ?
`

const viaPropertiesBySource = async (
  repo: Repo,
  workspaceId: string,
  targetId: string,
  sourceIds: readonly string[],
): Promise<Map<string, string[]>> => {
  const rows = await repo.db.getAll<{source_id: string, source_field: string, n: number}>(
    SOURCE_FIELDS_FOR_SOURCES_SQL,
    [JSON.stringify(sourceIds), workspaceId, targetId, MAX_VIA],
  )
  const fields = new Map<string, {names: string[], total: number}>()
  for (const row of rows) {
    const entry = fields.get(row.source_id) ?? {names: [], total: row.n}
    entry.names.push(row.source_field)
    fields.set(row.source_id, entry)
  }
  return new Map([...fields].map(([id, {names, total}]) => [id, boundLabels(names, MAX_VIA, NAME_CHARS, total)]))
}

const loadTarget = async (repo: Repo, ref: string, workspaceId: string): Promise<{block: BlockData, target: Target}> => {
  const {root} = await loadRoot(repo, ref, workspaceId, async id => (await loadBlocks(repo, [id]))[0])
  const shortIds = await displayIds(repo, [root.id])
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
  positionOf: (id: string) => number,
): Promise<BacklinkRow[]> => {
  const ids = sources.map(source => source.id)
  const linkOnly = sources.filter(source => isReferenceOnly(source.content))
  // A self-parented source (sync applies parent ids verbatim) has no parent to quote.
  const parentIds = [...new Set(linkOnly
    .map(source => source.parentId)
    .filter((id, index): id is string => id !== null && id !== linkOnly[index].id))]
  const [renderer, shortIds, crumbs, childCounts, via, parents, firstChildren] = await Promise.all([
    createPropertyRenderer(repo, sources, 'brief'),
    displayIds(repo, ids),
    loadCrumbs(repo, ids, workspaceId),
    visibleChildCounts(repo, ids),
    viaPropertiesBySource(repo, workspaceId, targetId, ids),
    loadBlocks(repo, parentIds),
    firstVisibleChildren(repo, linkOnly.map(source => source.id)),
  ])
  const parentById = new Map(parents.map(parent => [parent.id, parent]))
  return sources.map(source => {
    const row: BacklinkRow = {
      ...toViewRow(source, {shortIds, renderer, maxChars: ROW_CHARS}),
      position: positionOf(source.id),
      parentId: source.parentId,
      breadcrumb: crumbs.get(source.id) ?? [],
      childCount: childCounts.get(source.id) ?? 0,
      viaProperties: via.get(source.id) ?? [],
    }
    if (isReferenceOnly(source.content)) {
      const parent = source.parentId ? parentById.get(source.parentId) : undefined
      // A sync-applied parent edge can cross workspaces; that parent is not this block's context.
      if (parent && parent.workspaceId === source.workspaceId && parent.content.trim()) {
        row.parentContent = clipLine(parent.content, CONTEXT_CHARS).text
      }
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

/** Pages the shared backlinks query's full id list, as the backlinks panel
 *  loads it; a count and a paged variant belong in that query, so the panel
 *  and this view keep one definition of the set (a tracked follow-up). */
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
    rows: await backlinkRows(repo, block.workspaceId, block.id, sources, id => offset + page.indexOf(id) + 1),
  }
}

/** Rows under one parent block share their location (a page's worth of
 *  `[[Topic]]` bullets), and repeating it per row is the noise this view
 *  exists to remove. Compared by parent id — two parents can read alike. */
const samePlace = (row: BacklinkRow, previous: BacklinkRow): boolean =>
  row.parentId !== null && row.parentId === previous.parentId

const renderBacklinkRow = (row: BacklinkRow, index: number, samePlace: boolean): string[] => {
  const via = row.viaProperties.length > 0 ? `  [via ${row.viaProperties.join(', ')}]` : ''
  const children = row.childCount > 0 ? `  (${plural(row.childCount, 'child', 'children')})` : ''
  const body = `${row.content}${metaSuffix(row)}${children}`
  const firstChild = row.firstChildContent ? `   ↳ first child: ${row.firstChildContent}` : null
  if (samePlace) {
    return [`${index}. ^${row.shortId}  (same place as above)${via}  ${body}`, ...(firstChild ? [firstChild] : [])]
  }
  const lines = [`${index}. ^${row.shortId}  ${crumbLine(row.breadcrumb)}${via}`, `   ${body}`]
  if (row.parentContent) lines.push(`   ↳ parent: ${row.parentContent}`)
  if (firstChild) lines.push(firstChild)
  return lines
}

/** `consumed` counts the listing positions this page took, which can exceed
 *  the rows shown when some were deleted before they could be read. */
const rangeNote = (offset: number, consumed: number, total: number, nextOffset: number | null): string => {
  if (consumed === 0) {
    // Ids consumed but all deleted meanwhile still leave a next page.
    if (nextOffset !== null) return `none left on this page of ${formatCount(total)} (next: offset=${nextOffset})`
    return offset > 0 ? `none past offset ${formatCount(offset)} of ${formatCount(total)}` : 'none'
  }
  const range = `${formatCount(offset + 1)}–${formatCount(offset + consumed)} of ${formatCount(total)}`
  return nextOffset === null ? range : `${range} (next: offset=${nextOffset})`
}

export const renderBacklinksView = (view: BacklinksView): string => {
  const lines = [
    `Backlinks of "${view.target.title}" ^${view.target.shortId} — ${rangeNote(view.offset, Math.max(0, (view.nextOffset ?? view.total) - view.offset), view.total, view.nextOffset)}`,
  ]
  view.rows.forEach((row, index) => {
    lines.push(...renderBacklinkRow(row, row.position, index > 0 && samePlace(row, view.rows[index - 1])))
  })
  if (view.rows.some(row => row.cut > 0)) lines.push(CUT_LEGEND)
  return joinDisplayLines(lines)
}

// ----- grouped -----

export interface GroupedBacklinksParams extends BacklinksParams {
  membersPerGroup?: number
  memberOffset?: number
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
  /** Where this group's listing continues: past the member ids consumed,
   *  hydrated or not (one deleted meanwhile is skipped, not re-listed). */
  nextMemberOffset: number | null
}

export interface GroupedBacklinksView {
  target: Target
  total: number
  groupCount: number
  offset: number
  nextOffset: number | null
  /** Where each group's member listing starts. */
  memberOffset: number
  groups: BacklinkGroup[]
}

export const buildGroupedBacklinksView = async (
  repo: Repo,
  workspaceId: string,
  params: GroupedBacklinksParams,
): Promise<GroupedBacklinksView> => {
  const limit = clampInt(params.limit, AGENT_VIEW_DEFAULTS.groupsLimit, MAX_GROUPS)
  const requestedPerGroup = clampInt(params.membersPerGroup, AGENT_VIEW_DEFAULTS.membersPerGroup, MAX_BACKLINKS)
  const memberOffset = params.memberOffset ?? 0
  const membersOf = (sourceIds: readonly string[]) => sourceIds.slice(memberOffset, memberOffset + membersPerGroup)
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
  // One member budget for the whole page, so many groups times many members
  // cannot multiply past what a single backlinks page may hydrate.
  const membersPerGroup = Math.max(1, Math.min(requestedPerGroup, Math.floor(MAX_BACKLINKS / Math.max(1, page.length))))
  const memberIds = [...new Set(page.flatMap(group => membersOf(group.sourceIds)))]
  // A group is a block when that block exists — not when its id looks like
  // one: sync admits non-canonical ids, and the fallback group is no block.
  const [members, groupBlocks] = await Promise.all([
    loadBlocks(repo, memberIds),
    loadBlocks(repo, page.filter(group => !group.fallback).map(group => group.groupId)),
  ])
  const groupIds = groupBlocks.map(groupBlock => groupBlock.id)
  const blockGroupIds = new Set(groupIds)
  const [renderer, shortIds] = await Promise.all([
    createPropertyRenderer(repo, members, 'brief'),
    displayIds(repo, [...memberIds, ...groupIds]),
  ])
  const memberById = new Map(members.map(member => [member.id, member]))
  const end = offset + page.length

  return {
    target,
    total: result.total,
    groupCount: result.groups.length,
    offset,
    nextOffset: end < result.groups.length ? end : null,
    memberOffset,
    groups: page.map(group => {
      const isBlock = blockGroupIds.has(group.groupId)
      const consumed = membersOf(group.sourceIds)
      const nextMemberOffset = memberOffset + consumed.length
      return {
        label: clipLine(group.label, TITLE_CHARS).text,
        groupId: isBlock ? group.groupId : null,
        shortId: isBlock ? shortIds.get(group.groupId) ?? group.groupId : null,
        fallback: group.fallback,
        memberCount: group.sourceIds.length,
        nextMemberOffset: nextMemberOffset < group.sourceIds.length ? nextMemberOffset : null,
        members: consumed
          .flatMap(id => {
            const member = memberById.get(id)
            return member ? [toViewRow(member, {shortIds, renderer, maxChars: ROW_CHARS})] : []
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
    if (view.memberOffset > 0) lines.push(`  (members from #${formatCount(view.memberOffset + 1)})`)
    for (const member of group.members) lines.push(`- ${member.content}${metaSuffix(member)}  ^${member.shortId}`)
    if (group.nextMemberOffset !== null) {
      const rest = group.memberCount - group.nextMemberOffset
      lines.push(`  +${formatCount(rest)} more — memberOffset=${group.nextMemberOffset} offset=${view.offset + index} limit=1 continues this group`)
    }
  })
  if (view.groups.some(group => group.members.some(member => member.cut > 0))) lines.push(CUT_LEGEND)
  return joinDisplayLines(lines)
}
