import type { Repo } from '@/data/repo'
import type { BlockData } from '@/data/api'
import { isCollapsedProp } from '@/data/properties.js'
import { AGENT_VIEW_DEFAULTS } from '@knowledge-medium/agent-cli/protocol'
import { loadBlocks, loadCrumbs, visibleChildCounts, visibleChildrenLevel } from './context.ts'
import { displayIds } from './displayIds.ts'
import { createPropertyRenderer, type PropertyDetail } from './properties.ts'
import {
  clampInt,
  CUT_LEGEND,
  crumbLine,
  joinDisplayLines,
  loadRoot,
  metaSuffix,
  plural,
  toViewRow,
  type ViewRow,
} from './shared.ts'
import { formatCount } from './text.ts'

export interface OutlineParams {
  ref: string
  depth?: number
  limit?: number
  offset?: number
  properties?: PropertyDetail | 'none'
  expandCollapsed?: boolean
}

export interface OutlineRow extends ViewRow {
  parentId: string
  /** 1 for the root's children. */
  depth: number
  childCount: number
  /** Children not shown: past `depth`, past the block budget, or collapsed. */
  hiddenChildren: number
  collapsed: boolean
}

export interface OutlineView {
  root: ViewRow & {breadcrumb: string[], childCount: number}
  rows: OutlineRow[]
  offset: number
  /** The first root-child offset not shown, or null when the listing of the
   *  root's children is complete. */
  nextOffset: number | null
}

const MAX_DEPTH = 20
const MAX_BLOCKS = 2000
const LINE_CHARS = 200
const ROOT_CHARS = 300

interface Node {
  block: BlockData
  childCount: number
  depth: number
  children: string[]
  /** Child rows refused as a cycle back to an already-placed block: counted
   *  by `childCount`, but nothing more to expand. Only rows actually fetched
   *  are seen; a cycle edge past the depth or under a collapsed block still
   *  counts — accepted, since excluding it needs an ancestry walk per child
   *  and only corrupt (cyclic) data has one. */
  cycleChildren: number
}

const isCollapsed = (block: BlockData): boolean => block.properties[isCollapsedProp.name] === true

/** Pick what to show breadth-first, so a budget spent on one deep branch never
 *  hides the root's other children: level by level, each level ordered by its
 *  parents' position and then sibling order, until the block budget or the
 *  depth runs out. */
const selectNodes = async (
  repo: Repo,
  root: BlockData,
  {depth, limit, offset, expandCollapsed}: {depth: number, limit: number, offset: number, expandCollapsed: boolean},
): Promise<Map<string, Node>> => {
  const nodes = new Map<string, Node>()
  let budget = limit
  // The root shows its children even when collapsed, as the app shows those of
  // a collapsed block zoomed into; collapsed summarizes a block below the root.
  let frontier = [root.id]
  for (let level = 1; level <= depth && budget > 0 && frontier.length > 0; level++) {
    const rows = await visibleChildrenLevel(repo, frontier, {workspaceId: root.workspaceId, limit: budget, offset: level === 1 ? offset : 0})
    budget -= rows.length
    const next: string[] = []
    for (const {block, childCount} of rows) {
      // A parent cycle (sync applies parent ids verbatim) leads back to a
      // block already placed; placing it again would re-parent it.
      if (block.id === root.id || nodes.has(block.id)) {
        const parent = nodes.get(block.parentId ?? '')
        if (parent) parent.cycleChildren += 1
        continue
      }
      nodes.set(block.id, {block, childCount, depth: level, children: [], cycleChildren: 0})
      const parent = nodes.get(block.parentId ?? '')
      parent?.children.push(block.id)
      if (childCount > 0 && (expandCollapsed || !isCollapsed(block))) next.push(block.id)
    }
    frontier = next
  }
  return nodes
}

export const buildOutlineView = async (
  repo: Repo,
  workspaceId: string,
  params: OutlineParams,
): Promise<OutlineView> => {
  const depth = clampInt(params.depth, AGENT_VIEW_DEFAULTS.outlineDepth, MAX_DEPTH)
  const limit = clampInt(params.limit, AGENT_VIEW_DEFAULTS.outlineLimit, MAX_BLOCKS)
  const offset = params.offset ?? 0
  const detail = params.properties ?? 'brief'

  const {root} = await loadRoot(repo, params.ref, workspaceId, async id => (await loadBlocks(repo, [id]))[0])
  const [nodes, crumbs] = await Promise.all([
    selectNodes(repo, root, {depth, limit, offset, expandCollapsed: params.expandCollapsed === true}),
    loadCrumbs(repo, [root.id], workspaceId),
  ])
  // Counted after the page, so a child sync adds while it is read leaves a
  // continuation; a count taken first could end a full page with none. The
  // children already shown are its floor, as for every row below.
  const rootChildren = [...nodes.values()].filter(node => node.depth === 1).map(node => node.block.id)
  const counted = (await visibleChildCounts(repo, [root.id], workspaceId)).get(root.id) ?? 0
  const rootChildCount = Math.max(counted, offset + rootChildren.length)

  const blocks = [root, ...[...nodes.values()].map(node => node.block)]
  const [renderer, shortIds] = await Promise.all([
    createPropertyRenderer(repo, blocks, detail),
    displayIds(repo, blocks.map(block => block.id)),
  ])

  const rows: OutlineRow[] = []
  const visit = (parentId: string, childIds: readonly string[]) => {
    for (const id of childIds) {
      const node = nodes.get(id)!
      // A count read a level before its children can be short of them by
      // what sync added since; the children shown are the floor.
      const shown = node.children.length + node.cycleChildren
      const childCount = Math.max(node.childCount, shown)
      rows.push({
        ...toViewRow(node.block, {shortIds, renderer, maxChars: LINE_CHARS}),
        parentId,
        depth: node.depth,
        childCount,
        hiddenChildren: childCount - shown,
        collapsed: isCollapsed(node.block),
      })
      visit(id, node.children)
    }
  }
  visit(root.id, rootChildren)

  const shownEnd = offset + rootChildren.length
  return {
    root: {
      ...toViewRow(root, {shortIds, renderer, maxChars: ROOT_CHARS}),
      breadcrumb: crumbs.get(root.id) ?? [],
      childCount: rootChildCount,
    },
    rows,
    offset,
    nextOffset: shownEnd < rootChildCount ? shownEnd : null,
  }
}

export const renderOutlineView = (view: OutlineView): string => {
  const {root, rows} = view
  const lines: string[] = []
  lines.push(`${root.content}  ^${root.shortId}${metaSuffix(root)}  · ${plural(root.childCount, 'child', 'children')}`)
  if (root.breadcrumb.length > 0) lines.push(`in: ${crumbLine(root.breadcrumb)}`)
  if (view.offset > 0) lines.push(`(children from #${formatCount(view.offset + 1)})`)

  let sawHidden = false
  let sawCut = root.cut > 0
  for (const row of rows) {
    const hidden = row.hiddenChildren > 0
      ? `  (+${plural(row.hiddenChildren, 'child', 'children')}${row.collapsed ? ', collapsed' : ''})`
      : ''
    sawHidden ||= hidden !== ''
    sawCut ||= row.cut > 0
    lines.push(`${'  '.repeat(row.depth - 1)}- ${row.content}${metaSuffix(row)}  ^${row.shortId}${hidden}`)
  }

  if (view.nextOffset !== null) {
    const rest = root.childCount - view.nextOffset
    lines.push(`… ${plural(rest, 'more child', 'more children')} of the root not shown — continue with offset=${view.nextOffset}`)
  }
  if (sawHidden) lines.push('(+N children) = not expanded here; raise depth, or read that block by its id.')
  if (sawCut) lines.push(CUT_LEGEND)
  return joinDisplayLines(lines)
}
