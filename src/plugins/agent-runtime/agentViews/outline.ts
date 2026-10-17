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
  displayLineChars,
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
  /** Children not shown: past `depth`, past either budget, or collapsed. */
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
  /** Blocks selected but left out to keep the outline within
   *  `AGENT_VIEW_DEFAULTS.outlineChars`; 0 when nothing was. */
  budgetDropped: number
}

const MAX_DEPTH = 20
const MAX_BLOCKS = 2000
const LINE_CHARS = AGENT_VIEW_DEFAULTS.lineChars
const ROOT_CHARS = 300
const OUTPUT_CHARS = AGENT_VIEW_DEFAULTS.outlineChars

interface Node {
  block: BlockData
  /** Never below the children read, which a count taken a level before them
   *  can be short of by what sync added since. */
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
  for (const node of nodes.values()) node.childCount = Math.max(node.childCount, node.children.length + node.cycleChildren)
  return nodes
}

/** Keep the longest prefix of the selection, in its breadth-first order (so
 *  no block is kept without its parent), whose lines fit `budget`, and remove
 *  the rest from `nodes` and from their parents' children. The first is kept
 *  whatever its length, so a continuation always moves forward. Returns how
 *  many were removed. */
const keepWithinBudget = (nodes: Map<string, Node>, budget: number, lineChars: (node: Node) => number): number => {
  let left = budget
  let kept = 0
  for (const node of nodes.values()) {
    left -= lineChars(node)
    if (left < 0 && kept > 0) break
    kept += 1
  }
  const dropped = [...nodes.keys()].slice(kept)
  for (const id of dropped) nodes.delete(id)
  for (const node of nodes.values()) node.children = node.children.filter(id => nodes.has(id))
  return dropped.length
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
  // continuation; a count taken first could end a full page with none. A page
  // that read children is its floor, as for every row below; an empty one is
  // no evidence that the offset it skipped exists.
  const rootChildrenRead = [...nodes.values()].filter(node => node.depth === 1).length
  const counted = (await visibleChildCounts(repo, [root.id], workspaceId)).get(root.id) ?? 0
  const rootChildCount = rootChildrenRead > 0 ? Math.max(counted, offset + rootChildrenRead) : counted

  const blocks = [root, ...[...nodes.values()].map(node => node.block)]
  const [renderer, shortIds] = await Promise.all([
    createPropertyRenderer(repo, blocks, detail),
    displayIds(repo, blocks.map(block => block.id)),
  ])

  const viewRoot = {
    ...toViewRow(root, {shortIds, renderer, maxChars: ROOT_CHARS}),
    breadcrumb: crumbs.get(root.id) ?? [],
    childCount: rootChildCount,
  }
  const viewRows = new Map([...nodes].map(([id, node]) => [id, toViewRow(node.block, {shortIds, renderer, maxChars: LINE_CHARS})]))
  const rowFields = (node: Node, hiddenChildren: number) => ({
    ...viewRows.get(node.block.id)!,
    depth: node.depth,
    childCount: node.childCount,
    hiddenChildren,
    collapsed: isCollapsed(node.block),
  })
  const headerChars = headerLines({root: viewRoot, offset}).reduce((sum, line) => sum + displayLineChars(line), 0)
  // A row is measured with all its children hidden, the longest it can print.
  const budgetDropped = keepWithinBudget(nodes, OUTPUT_CHARS - headerChars,
    node => displayLineChars(rowLine(rowFields(node, node.childCount))))

  const rootChildren = [...nodes.values()].filter(node => node.depth === 1).map(node => node.block.id)
  const rows: OutlineRow[] = []
  const visit = (parentId: string, childIds: readonly string[]) => {
    for (const id of childIds) {
      const node = nodes.get(id)!
      rows.push({...rowFields(node, node.childCount - node.children.length - node.cycleChildren), parentId})
      visit(id, node.children)
    }
  }
  visit(root.id, rootChildren)

  const shownEnd = offset + rootChildren.length
  return {
    root: viewRoot,
    rows,
    offset,
    nextOffset: shownEnd < rootChildCount ? shownEnd : null,
    budgetDropped,
  }
}

const headerLines = ({root, offset}: Pick<OutlineView, 'root' | 'offset'>): string[] => [
  `${root.content}  ^${root.shortId}${metaSuffix(root)}  · ${plural(root.childCount, 'child', 'children')}`,
  ...(root.breadcrumb.length > 0 ? [`in: ${crumbLine(root.breadcrumb)}`] : []),
  ...(offset > 0 ? [`(children from #${formatCount(offset + 1)})`] : []),
]

const hiddenSuffix = (row: Pick<OutlineRow, 'hiddenChildren' | 'collapsed'>): string => row.hiddenChildren > 0
  ? `  (+${plural(row.hiddenChildren, 'child', 'children')}${row.collapsed ? ', collapsed' : ''})`
  : ''

const rowLine = (row: Omit<OutlineRow, 'parentId'>): string =>
  `${'  '.repeat(row.depth - 1)}- ${row.content}${metaSuffix(row)}  ^${row.shortId}${hiddenSuffix(row)}`

export const renderOutlineView = (view: OutlineView): string => {
  const {root, rows} = view
  const lines = headerLines(view)
  let sawHidden = false
  let sawCut = root.cut > 0
  for (const row of rows) {
    sawHidden ||= row.hiddenChildren > 0
    sawCut ||= row.cut > 0
    lines.push(rowLine(row))
  }

  if (view.nextOffset !== null) {
    const rest = root.childCount - view.nextOffset
    lines.push(`… ${plural(rest, 'more child', 'more children')} of the root not shown — continue with offset=${view.nextOffset}`)
  }
  if (view.budgetDropped > 0) {
    lines.push(`… ${plural(view.budgetDropped, 'more selected block')} not shown, past the ${formatCount(OUTPUT_CHARS)}-character output budget`
      + ` — narrow with properties=none, a lower limit or depth, or search with under=^${root.shortId}`)
  }
  if (sawHidden) lines.push('(+N children) = not expanded here; raise depth, or read that block by its id.')
  if (sawCut) lines.push(CUT_LEGEND)
  return joinDisplayLines(lines)
}
