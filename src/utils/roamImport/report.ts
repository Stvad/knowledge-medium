import { ChangeScope, type Tx } from '@/data/api'
import { dailyNoteBlockId, getOrCreateDailyNote, todayIso } from '@/data/dailyNotes'
import { keyAtEnd, keysBetween } from '@/data/orderKey'
import type { Repo } from '@/data/repo'
import type { RoamMemoImportPlanSummary } from './roamMemo'
import {
  formatTypeCandidateReport,
  type RoamTypeCandidate,
} from './typeCandidates'

interface ImportLogStats {
  pagesCreated: number
  pagesMerged: number
  pagesDaily: number
  blocksWritten: number
  placeholdersCreated: number
  aliasBlocksCreated: number
  typeCandidates: ReadonlyArray<RoamTypeCandidate>
  roamMemo: RoamMemoImportPlanSummary
  durationMs: number
  diagnostics: ReadonlyArray<string>
}

interface ReportNode {
  content: string
  children?: ReadonlyArray<ReportNode>
}

const formatRoamMemoReport = (
  summary: RoamMemoImportPlanSummary,
): string[] => {
  if (summary.entries === 0) return []

  const lines = [
    `${summary.matchedTargets}/${summary.entries} entries matched imported blocks`,
    `${summary.activeTargets} active, ${summary.archivedTargets} archived, ${summary.toReviewRefs} to-review refs preserved as source tags`,
    `${summary.snapshots} snapshots imported across ${summary.matchedTargets} blocks`,
    `${summary.targetsWithHistory} blocks had multi-snapshot review history`,
  ]
  if (summary.missingTargets > 0) {
    lines.push(`${summary.missingTargets} entries referenced missing target blocks`)
  }
  if (summary.unsupportedSessions > 0) {
    lines.push(`${summary.unsupportedSessions} session rows were skipped because they were not SPACED_INTERVAL snapshots`)
  }
  return lines
}

const formatDuration = (durationMs: number): string =>
  `${(durationMs / 1000).toFixed(1)}s`

const formatSummaryReport = (stats: ImportLogStats): string[] => [
  `Pages: ${stats.pagesCreated} new, ${stats.pagesMerged} merged, ${stats.pagesDaily} daily`,
  `Blocks: ${stats.blocksWritten} imported`,
  `Support rows: ${stats.placeholdersCreated} placeholders, ${stats.aliasBlocksCreated} alias seats`,
  `Notes: ${stats.diagnostics.length}`,
  `Duration: ${formatDuration(stats.durationMs)}`,
]

const OTHER_DIAGNOSTIC_GROUP = 'Other notes'

const DIAGNOSTIC_GROUPS: ReadonlyArray<{
  title: string
  matches: (line: string) => boolean
}> = [
  {
    title: 'Duplicate uids',
    matches: line => line.includes('Duplicate Roam uid'),
  },
  {
    title: 'Page titles',
    matches: line => line.includes('Roam page title weirdness'),
  },
  {
    title: 'Page aliases',
    matches: line =>
      line.includes('page_alias') ||
      line.includes('Page alias') ||
      line.includes('alias rule'),
  },
  {
    title: 'Roam commands',
    matches: line =>
      line.includes('Roam command follow-up') ||
      line.includes('Unknown Roam command follow-up'),
  },
  {
    title: 'SRS and roam/memo',
    matches: line =>
      line.includes('SRS') ||
      line.includes('roam/memo') ||
      line.includes('SPACED_INTERVAL'),
  },
  {
    title: 'References and placeholders',
    matches: line =>
      line.includes('placeholder') ||
      line.includes('block-ref') ||
      line.includes('unresolved aliases') ||
      line.includes('ref property') ||
      line.includes('daily note') ||
      line.includes('Daily page') ||
      line.startsWith('Alias "'),
  },
  {
    title: 'Properties and schemas',
    matches: line =>
      line.includes('Attribute "') ||
      line.includes('property') ||
      line.includes('schema') ||
      line.includes('Readwise'),
  },
]

const diagnosticGroupTitle = (line: string): string =>
  DIAGNOSTIC_GROUPS.find(group => group.matches(line))?.title ?? OTHER_DIAGNOSTIC_GROUP

const formatDiagnosticReport = (
  diagnostics: ReadonlyArray<string>,
): ReportNode[] => {
  if (diagnostics.length === 0) return []

  const grouped = new Map<string, string[]>()
  for (const line of diagnostics) {
    const title = diagnosticGroupTitle(line)
    const lines = grouped.get(title) ?? []
    lines.push(line)
    grouped.set(title, lines)
  }

  const sections = [
    ...DIAGNOSTIC_GROUPS.map(group => group.title),
    OTHER_DIAGNOSTIC_GROUP,
  ].flatMap(title => {
    const lines = grouped.get(title)
    if (!lines || lines.length === 0) return []
    return [{
      content: `${title} (${lines.length})`,
      children: lines.map(content => ({content})),
    }]
  })

  return [{
    content: `Notes (${diagnostics.length})`,
    children: sections,
  }]
}

const createReportNodes = async (
  tx: Tx,
  workspaceId: string,
  parentId: string,
  nodes: ReadonlyArray<ReportNode>,
): Promise<void> => {
  if (nodes.length === 0) return
  const keys = keysBetween(null, null, nodes.length)
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    const id = await tx.create({
      workspaceId,
      parentId,
      orderKey: keys[i],
      content: node.content,
    })
    if (node.children && node.children.length > 0) {
      await createReportNodes(tx, workspaceId, id, node.children)
    }
  }
}

/**
 * Append a one-parent + N-children block to today's daily-note that
 * records the just-finished import. Header summarises counts; children
 * group summary, diagnostics, and follow-up sections for scanning.
 */
export const writeImportLog = async (
  repo: Repo,
  workspaceId: string,
  stats: ImportLogStats,
): Promise<void> => {
  const iso = todayIso()
  // Make sure today's daily-note row exists. Idempotent: if today's
  // import already touched it, this is a cache hit.
  await getOrCreateDailyNote(repo, workspaceId, iso)
  const dailyId = dailyNoteBlockId(workspaceId, iso)
  const typeCandidateLines = formatTypeCandidateReport(stats.typeCandidates)
  const roamMemoLines = formatRoamMemoReport(stats.roamMemo)
  const typeCandidateSummary = stats.typeCandidates.length > 0
    ? `, ${stats.typeCandidates.length} type candidates`
    : ''
  const roamMemoSummary = stats.roamMemo.entries > 0
    ? `, ${stats.roamMemo.snapshots} roam/memo snapshots`
    : ''

  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const headerContent =
    `Roam import ${stamp}: ` +
    `${stats.pagesCreated} new pages, ${stats.pagesMerged} merged, ` +
    `${stats.pagesDaily} daily, ${stats.blocksWritten} blocks ` +
    `(${stats.placeholdersCreated} placeholders, ` +
    `${stats.aliasBlocksCreated} alias seats, ` +
    `${stats.diagnostics.length} notes${typeCandidateSummary}${roamMemoSummary}, ` +
    `${formatDuration(stats.durationMs)})`

  const reportNodes: ReportNode[] = [
    {
      content: 'Summary',
      children: formatSummaryReport(stats).map(content => ({content})),
    },
    ...formatDiagnosticReport(stats.diagnostics),
  ]
  if (roamMemoLines.length > 0) {
    reportNodes.push({
      content: 'Roam Memo SRS',
      children: roamMemoLines.map(content => ({content})),
    })
  }
  if (typeCandidateLines.length > 0) {
    reportNodes.push({
      content: 'Type candidates from isa::',
      children: typeCandidateLines.map(content => ({content})),
    })
  }

  await repo.tx(async tx => {
    const existing = await tx.childrenOf(dailyId, workspaceId)
    const lastKey = existing.length > 0
      ? existing[existing.length - 1].orderKey
      : null
    const headerOrderKey = keyAtEnd(lastKey)

    const headerId = await tx.create({
      workspaceId,
      parentId: dailyId,
      orderKey: headerOrderKey,
      content: headerContent,
    })

    await createReportNodes(tx, workspaceId, headerId, reportNodes)
  }, {scope: ChangeScope.BlockDefault, description: 'roam import: log'})
}
