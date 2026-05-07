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

const MAX_DIAGNOSTIC_SAMPLES = 8

const omittedLine = (count: number): ReportNode[] =>
  count > 0 ? [{content: `${count} more omitted from this report section.`}] : []

const sampleNodes = (lines: readonly string[]): ReportNode[] => [
  ...lines.slice(0, MAX_DIAGNOSTIC_SAMPLES).map(content => ({content})),
  ...omittedLine(lines.length - MAX_DIAGNOSTIC_SAMPLES),
]

const countBy = <T,>(values: readonly T[], keyOf: (value: T) => string): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const value of values) {
    const key = keyOf(value)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

const countLines = (counts: ReadonlyMap<string, number>): ReportNode[] =>
  [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({content: `${name}: ${count}`}))

const summarizeAttributeHoists = (
  lines: readonly string[],
): {nodes: ReportNode[], remaining: string[]} => {
  const matched: Array<{line: string, key: string}> = []
  const remaining: string[] = []
  for (const line of lines) {
    const match = /^Attribute "([^"]+)" hoisted from depth (\d+) /.exec(line)
    if (match) matched.push({line, key: `${match[1]} depth ${match[2]}`})
    else remaining.push(line)
  }
  if (matched.length === 0) return {nodes: [], remaining}
  return {
    nodes: [{
      content: `Deep attribute hoists (${matched.length})`,
      children: [
        ...countLines(countBy(matched, item => item.key)),
        {
          content: 'Samples',
          children: sampleNodes(matched.map(item => item.line)),
        },
      ],
    }],
    remaining,
  }
}

const readwiseExtractionKind = (line: string): string | null => {
  if (!line.startsWith('Readwise property extraction on uid ')) return null
  if (line.includes('had blank author before url:.')) return 'blank author before url'
  if (line.includes('had blank author before via.')) return 'blank author before via'
  if (line.includes('had blank [[]] author')) return 'blank [[]] author'
  if (line.includes('exact author refs')) return 'multiple exact author refs'
  return 'other Readwise extraction warning'
}

const summarizeReadwiseExtractions = (
  lines: readonly string[],
): {nodes: ReportNode[], remaining: string[]} => {
  const matched: Array<{line: string, key: string}> = []
  const remaining: string[] = []
  for (const line of lines) {
    const key = readwiseExtractionKind(line)
    if (key) matched.push({line, key})
    else remaining.push(line)
  }
  if (matched.length === 0) return {nodes: [], remaining}
  return {
    nodes: [{
      content: `Readwise extraction warnings (${matched.length})`,
      children: [
        ...countLines(countBy(matched, item => item.key)),
        {
          content: 'Samples',
          children: sampleNodes(matched.map(item => item.line)),
        },
      ],
    }],
    remaining,
  }
}

const summarizeReadwisePromotedConflicts = (
  lines: readonly string[],
): {nodes: ReportNode[], remaining: string[]} => {
  const matched: string[] = []
  const remaining: string[] = []
  for (const line of lines) {
    if (line.startsWith('Readwise promoted metadata conflict')) matched.push(line)
    else remaining.push(line)
  }
  if (matched.length === 0) return {nodes: [], remaining}
  const summary = matched.find(line => line.startsWith('Readwise promoted metadata conflicts:'))
  const samples = matched.filter(line => line.startsWith('Readwise promoted metadata conflict sample:'))
  return {
    nodes: [{
      content: `Readwise promoted metadata conflicts (${matched.length})`,
      children: [
        ...(summary ? [{content: summary}] : []),
        ...(samples.length > 0 ? [{content: 'Samples', children: sampleNodes(samples)}] : []),
      ],
    }],
    remaining,
  }
}

const summarizeSrsDiagnostics = (
  lines: readonly string[],
): {nodes: ReportNode[], remaining: string[]} => {
  const missingDate: string[] = []
  const multipleMarkers: string[] = []
  const remaining: string[] = []
  for (const line of lines) {
    if (line.includes('has interval/factor but no parseable daily review date')) {
      missingDate.push(line)
    } else if (line.startsWith('Multiple marker-only Roam SRS children')) {
      multipleMarkers.push(line)
    } else {
      remaining.push(line)
    }
  }
  const nodes: ReportNode[] = []
  if (missingDate.length > 0) {
    nodes.push({
      content: `SRS markers missing review dates (${missingDate.length})`,
      children: sampleNodes(missingDate),
    })
  }
  if (multipleMarkers.length > 0) {
    nodes.push({
      content: `Multiple marker-only SRS children (${multipleMarkers.length})`,
      children: sampleNodes(multipleMarkers),
    })
  }
  return {nodes, remaining}
}

const summarizePageAliasDiagnostics = (
  lines: readonly string[],
): {nodes: ReportNode[], remaining: string[]} => {
  const nonStandard: string[] = []
  const aliasMerges: string[] = []
  const remaining: string[] = []
  for (const line of lines) {
    if (line.startsWith('Non-standard page_alias')) {
      nonStandard.push(line)
    } else if (/^\[\[.+\]\] also had .+ merged in bc of the alias rule$/.test(line)) {
      aliasMerges.push(line)
    } else {
      remaining.push(line)
    }
  }
  const nodes: ReportNode[] = []
  if (nonStandard.length > 0) {
    nodes.push({
      content: `Non-standard page_alias values (${nonStandard.length})`,
      children: nonStandard.map(content => ({content})),
    })
  }
  if (aliasMerges.length > 0) {
    nodes.push({
      content: `Alias-rule page merges (${aliasMerges.length})`,
      children: aliasMerges.map(content => ({content})),
    })
  }
  return {nodes, remaining}
}

const summarizeDiagnosticLines = (
  title: string,
  lines: readonly string[],
): ReportNode[] => {
  let remaining = [...lines]
  const nodes: ReportNode[] = []
  const run = (
    summarizer: (input: readonly string[]) => {nodes: ReportNode[], remaining: string[]},
  ) => {
    const result = summarizer(remaining)
    nodes.push(...result.nodes)
    remaining = result.remaining
  }

  if (title === 'Properties and schemas') {
    run(summarizeAttributeHoists)
    run(summarizeReadwiseExtractions)
    run(summarizeReadwisePromotedConflicts)
  } else if (title === 'SRS and roam/memo') {
    run(summarizeSrsDiagnostics)
  } else if (title === 'Page aliases') {
    run(summarizePageAliasDiagnostics)
  }

  nodes.push(...remaining.map(content => ({content})))
  return nodes
}

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
      children: summarizeDiagnosticLines(title, lines),
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
  const typeCandidateSections = formatTypeCandidateReport(stats.typeCandidates)
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
  if (typeCandidateSections.length > 0) {
    reportNodes.push({
      content: 'Type candidates from isa::',
      children: typeCandidateSections.map(section => ({
        content: section.title,
        children: section.lines.map(content => ({content})),
      })),
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
