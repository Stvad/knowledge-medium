/**
 * The eval's comparable output: one JSON record per task execution plus the
 * deterministic output sizes, and a markdown rendering that can put a
 * second report beside it as a baseline.
 *
 * Sizes are characters (JavaScript string length) throughout: the unit
 * Claude Code's MCP output cap counts, and the only one its over-the-cap
 * notice reports.
 */
import { createHash } from 'node:crypto'
import { MCP_SERVER_NAME } from '../../packages/agent-cli/src/mcpShared'
import type { TokenUsage } from './transcript'

export const REPORT_SCHEMA_VERSION = 5

export interface TaskRunRecord {
  task: string
  kind: 'read' | 'write'
  rep: number
  pass: boolean
  detail: string
  toolCalls: number
  /** The wire commands the graph's host ran for the agent, by type, the
   *  same on every surface. */
  graphCommands: Record<string, number>
  toolErrors: number
  /** Characters of every tool result the agent saw. */
  seenChars: number
  maxSeenChars: number
  /** Results over Claude Code's output cap, which reached the agent only as
   *  a notice or a preview. */
  cappedCalls: number
  /** What the tools returned, capped results at their real size; null when
   *  any call's size is unknown, as in a run that timed out mid-call. */
  returnedChars: number | null
  apiCalls: number
  tokens: TokenUsage
  /** Wall-clock, measured by the runner, so a run that timed out has one. */
  elapsedMs: number
  /** Null when the run ended without a result line to report it. */
  costUsd: number | null
  terminalReason: string | null
  exitCode: number | null
  timedOut: boolean
  /** Blocks the run created / changed / removed, read from the graph afterwards. */
  writes: {created: number, modified: number, removed: number}
  transcript: string
}

/** What a run holds fixed besides its tasks, as the runner ran with it. A
 *  baseline that differs in any of these measures that difference rather
 *  than the tools, so it gets no deltas. Claude Code's version is recorded
 *  beside them, not among them, or a baseline would expire with every CLI
 *  release. */
export interface RunConditions {
  /** Of the generated export. */
  fixture: string
  /** Of the fixture as this checkout's code stores it (`fixtureState` of the
   *  run's template): an importer or data-layer change moves it while the
   *  export stays the same. */
  importedFixture: string
  /** How the agent reaches the graph (surfaces.ts). */
  surface: string
  /** Of that surface's preamble and tool set. */
  tools: string
  /** As the first run resolved it; null until then, or when no run got that far. */
  model: string | null
  effort: string
  /** MAX_MCP_OUTPUT_TOKENS and BASH_MAX_OUTPUT_LENGTH: they decide which
   *  results are cut short. */
  mcpOutputTokens: number
  bashOutputChars: number
  timeoutMs: number
  /** Tasks run at once: they share the machine and the account's rate limit. */
  workers: number
}

export interface EvalReport {
  schemaVersion: typeof REPORT_SCHEMA_VERSION
  label: string
  startedAt: string
  finishedAt: string
  git: {sha: string, branch: string, dirty: boolean}
  /** The model as requested; `conditions.model` is what it resolved to. */
  model: string
  conditions: RunConditions
  claudeCodeVersion: string | null
  /** As offered to Claude Code; the km MCP server's list may grow between
   *  comparable runs. */
  allowedTools: string[]
  /** Per task, a hash of its definition (prompt, check, allowed changes, the
   *  scoring modules). Deltas are shown only for tasks whose hash matches. */
  taskHashes: Record<string, string>
  /** Deterministic output sizes per probe, through the km MCP tools, measured
   *  on the run's template. */
  outputSizes: Record<string, number>
  /** Per probe, a hash of its call; deltas only where it matches. */
  probeHashes: Record<string, string>
  runs: TaskRunRecord[]
}

/** Identifies a definition, so a report compares only like with like. */
export const definitionHash = (definition: unknown): string =>
  createHash('sha256').update(JSON.stringify(definition)).digest('hex').slice(0, 12)

/** A report as stored, refused when it was written in another format. */
export const parseReport = (json: string, source: string): EvalReport => {
  const report = JSON.parse(json) as EvalReport
  if (report.schemaVersion !== REPORT_SCHEMA_VERSION) {
    throw new Error(`${source} is report format ${report.schemaVersion}, not ${REPORT_SCHEMA_VERSION}; record it again with this runner`)
  }
  return report
}

/** Every condition, by name; the type refuses a missing one. */
const CONDITION_NAMES: Record<keyof RunConditions, true> = {
  fixture: true, importedFixture: true, surface: true, tools: true, model: true, effort: true,
  mcpOutputTokens: true, bashOutputChars: true, timeoutMs: true, workers: true,
}
export const RUN_CONDITIONS = Object.keys(CONDITION_NAMES) as Array<keyof RunConditions>

/** The run conditions on which the two reports differ; an unknown value
 *  matches nothing. `planned` leaves out what a run has not resolved yet,
 *  unless the baseline never resolved it either: nothing could match then. */
export const conditionMismatches = (report: EvalReport, baseline: EvalReport, {planned = false} = {}): string[] =>
  RUN_CONDITIONS.flatMap(name => {
    const [was, now] = [baseline.conditions[name], report.conditions[name]]
    if (planned && now === null && was !== null) return []
    return was !== null && was === now ? [] : [`${name} ${was ?? 'unknown'} → ${now ?? 'unknown'}`]
  })

export interface TaskSummary {
  task: string
  kind: 'read' | 'write'
  reps: number
  passes: number
  toolCalls: number
  seenChars: number
  maxSeenChars: number
  cappedCalls: number
  /** Null when any repetition's figure is unknown, as is the cost. */
  returnedChars: number | null
  contextTokens: number
  peakContext: number
  outputTokens: number
  costUsd: number | null
  elapsedMs: number
}

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** Unknown in, unknown out: a figure missing from any input is not zero. */
const known = (values: ReadonlyArray<number | null>): readonly number[] | null =>
  values.every((value): value is number => value !== null) ? values : null

const knownMedian = (values: ReadonlyArray<number | null>): number | null => {
  const all = known(values)
  return all && median(all)
}

/** Per task, medians across repetitions (pass count is a count). */
export const summarize = (report: EvalReport): TaskSummary[] => {
  const byTask = new Map<string, TaskRunRecord[]>()
  for (const run of report.runs) byTask.set(run.task, [...(byTask.get(run.task) ?? []), run])
  return [...byTask.entries()].map(([task, runs]) => {
    return {
      task,
      kind: runs[0].kind,
      reps: runs.length,
      passes: runs.filter(run => run.pass).length,
      toolCalls: median(runs.map(run => run.toolCalls)),
      seenChars: median(runs.map(run => run.seenChars)),
      maxSeenChars: median(runs.map(run => run.maxSeenChars)),
      cappedCalls: median(runs.map(run => run.cappedCalls)),
      returnedChars: knownMedian(runs.map(run => run.returnedChars)),
      contextTokens: median(runs.map(run => run.tokens.contextTotal)),
      peakContext: median(runs.map(run => run.tokens.peakContext)),
      outputTokens: median(runs.map(run => run.tokens.output)),
      costUsd: knownMedian(runs.map(run => run.costUsd)),
      elapsedMs: median(runs.map(run => run.elapsedMs)),
    }
  })
}

const thousands = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : `${(n / 1000).toFixed(1)}k`)
const seconds = (ms: number) => `${Math.round(ms / 1000)}s`
const dollars = (usd: number) => `$${usd.toFixed(3)}`

/** "+12%" / "−40%" against a baseline value; empty when there is none. */
const delta = (current: number, base: number | null | undefined): string => {
  if (base === null || base === undefined || base === 0) return ''
  const pct = Math.round(((current - base) / base) * 100)
  return pct === 0 ? ' (±0%)' : ` (${pct > 0 ? '+' : '−'}${Math.abs(pct)}%)`
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)

/** A figure with its delta against the baseline figure, when there is one. */
const cell = (format: (n: number) => string, current: number | null, base?: number | null) =>
  (current === null ? 'n/a' : `${format(current)}${delta(current, base)}`)

/** The task table's figures, in column order. Each renders with its delta
 *  against the baseline, in every task row and in the totals. A peak is not
 *  totalled: a sum of per-task maxima means nothing. */
interface Figure {
  heading: string
  pick: (row: TaskSummary) => number | null
  format: (n: number) => string
  totalled: boolean
}
const FIGURES: readonly Figure[] = [
  {heading: 'tool calls', pick: row => row.toolCalls, format: String, totalled: true},
  {heading: 'capped', pick: row => row.cappedCalls, format: String, totalled: true},
  {heading: 'chars seen', pick: row => row.seenChars, format: thousands, totalled: true},
  {heading: 'max seen', pick: row => row.maxSeenChars, format: thousands, totalled: false},
  {heading: 'chars returned', pick: row => row.returnedChars, format: thousands, totalled: true},
  {heading: 'context tokens', pick: row => row.contextTokens, format: thousands, totalled: true},
  {heading: 'peak context', pick: row => row.peakContext, format: thousands, totalled: false},
  {heading: 'output tokens', pick: row => row.outputTokens, format: thousands, totalled: true},
  {heading: 'list $', pick: row => row.costUsd, format: dollars, totalled: true},
  {heading: 'time', pick: row => row.elapsedMs, format: seconds, totalled: true},
]

const totalsRow = (label: string, rows: readonly TaskSummary[], baseRows?: readonly TaskSummary[]) => {
  const total = (from: readonly TaskSummary[], pick: Figure['pick']) => {
    const all = known(from.map(pick))
    return all && sum(all)
  }
  const cells = FIGURES.map(figure => (figure.totalled
    ? cell(figure.format, total(rows, figure.pick), baseRows && total(baseRows, figure.pick))
    : ''))
  return `| ${label} | | ${sum(rows.map(row => row.passes))}/${sum(rows.map(row => row.reps))} | ${cells.join(' | ')} |`
}

export const renderMarkdown = (report: EvalReport, compareWith?: EvalReport): string => {
  const mismatches = compareWith ? conditionMismatches(report, compareWith) : []
  const baseline = mismatches.length === 0 ? compareWith : undefined
  const rows = summarize(report)
  const baselineRows = new Map((baseline ? summarize(baseline) : []).map(row => [row.task, row]))
  // Only a task measured on the same definition is comparable; a reworded
  // prompt or changed check is a different workload.
  const comparable = (task: string) => baselineRows.has(task)
    && baseline?.taskHashes[task] !== undefined && baseline.taskHashes[task] === report.taskHashes[task]
  const lines: string[] = []
  const reps = Math.max(...rows.map(row => row.reps))

  lines.push(`# Agent ergonomics eval — ${report.label}`, '')
  lines.push(`- commit \`${report.git.sha.slice(0, 10)}\` on \`${report.git.branch}\`${report.git.dirty ? ' (dirty tree)' : ''}`)
  const {conditions} = report
  lines.push(`- model \`${conditions.model ?? report.model}\`${conditions.effort === 'default' ? '' : `, effort ${conditions.effort}`}, Claude Code ${report.claudeCodeVersion ?? '?'}`)
  lines.push(`- surface \`${conditions.surface}\`, tools allowed: ${report.allowedTools.map(tool => `\`${tool.replace(`mcp__${MCP_SERVER_NAME}__`, '')}\``).join(', ')}; `
    + `output caps ${conditions.mcpOutputTokens} tokens (MCP), ${conditions.bashOutputChars} characters (shell); ${conditions.workers} task(s) at a time`)
  lines.push('- sizes are characters; "capped": results over their cap, which Claude Code cut short or replaced with a notice; "seen" is what reached the model, "returned" what the tools produced, n/a where that is unknown')
  lines.push(`- fixture \`${conditions.fixture}\` (stored as \`${conditions.importedFixture}\`), ${reps} repetition(s) per task, ${conditions.timeoutMs / 60_000} min timeout each; per-task figures are medians; lower is better except pass`)
  lines.push('- list $ is the API list-price equivalent the CLI reports (a subscription run is not charged it); it weights input, cache and output tokens in one number; n/a where a run ended without reporting it')
  if (compareWith && !baseline) {
    lines.push(`- **not compared** with ${compareWith.label}: the runs differ in ${mismatches.join('; ')}`)
  }
  if (baseline) {
    const cli = baseline.claudeCodeVersion !== report.claudeCodeVersion
      ? `; Claude Code ${baseline.claudeCodeVersion ?? '?'} → ${report.claudeCodeVersion ?? '?'}` : ''
    lines.push(`- compared with **${baseline.label}** (commit \`${baseline.git.sha.slice(0, 10)}\`${cli}); deltas in parentheses, `
      + `for the ${rows.filter(row => comparable(row.task)).length} of ${rows.length} tasks whose definition is unchanged`)
  }
  lines.push('')

  lines.push(`| task | kind | pass | ${FIGURES.map(figure => figure.heading).join(' | ')} |`)
  lines.push(`|${'---|'.repeat(3 + FIGURES.length)}`)
  for (const row of rows) {
    const was = comparable(row.task) ? baselineRows.get(row.task) : undefined
    const note = was ? ` (was ${was.passes}/${was.reps})` : baselineRows.has(row.task) ? ' (task changed since baseline)' : ''
    const cells = FIGURES.map(figure => cell(figure.format, figure.pick(row), was && figure.pick(was)))
    lines.push(`| ${row.task} | ${row.kind} | ${row.passes}/${row.reps}${note} | ${cells.join(' | ')} |`)
  }
  // Aggregates compare like with like: when some tasks are new or changed,
  // the all-tasks total carries no delta and a comparable-subset row does.
  const comparableRows = rows.filter(row => comparable(row.task))
  const baseFor = (from: readonly TaskSummary[]) => from.map(row => baselineRows.get(row.task)!)
  const allComparable = baseline !== undefined && comparableRows.length === rows.length
  lines.push(totalsRow('**all**', rows, allComparable ? baseFor(rows) : undefined))
  if (baseline && !allComparable && comparableRows.length > 0) {
    lines.push(totalsRow(`**comparable (${comparableRows.length})**`, comparableRows, baseFor(comparableRows)))
  }
  lines.push('')

  const failures = report.runs.filter(run => !run.pass)
  if (failures.length > 0) {
    lines.push('## Failures', '')
    for (const run of failures) {
      const ended = run.timedOut ? ' (timed out)'
        : run.terminalReason && run.terminalReason !== 'completed' ? ` (ended: ${run.terminalReason})` : ''
      lines.push(`- ${run.task} #${run.rep}: ${run.detail}${ended}`)
    }
    lines.push('')
  }

  const unexpectedWrites = report.runs.filter(run => run.kind === 'read' && run.writes.created + run.writes.modified + run.writes.removed > 0)
  if (unexpectedWrites.length > 0) {
    lines.push('## Writes during read tasks', '')
    for (const run of unexpectedWrites) {
      lines.push(`- ${run.task} #${run.rep}: ${run.writes.created} created, ${run.writes.modified} modified, ${run.writes.removed} removed`)
    }
    lines.push('')
  }

  lines.push('## Graph commands', '')
  lines.push('| task | wire commands the graph ran, by type (all repetitions) | tool errors |')
  lines.push('|---|---|---|')
  for (const row of rows) {
    const counts: Record<string, number> = {}
    let errors = 0
    for (const run of report.runs.filter(item => item.task === row.task)) {
      errors += run.toolErrors
      for (const [type, count] of Object.entries(run.graphCommands)) counts[type] = (counts[type] ?? 0) + count
    }
    const rendered = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => `${type} ×${count}`)
      .join(', ')
    lines.push(`| ${row.task} | ${rendered || '—'} | ${errors} |`)
  }
  lines.push('')

  // A probe whose call changed measures a different workload.
  const baseSize = (probe: string) => {
    const hash = report.probeHashes[probe]
    return hash !== undefined && baseline?.probeHashes[probe] === hash ? baseline.outputSizes[probe] : undefined
  }
  lines.push('## Output sizes on the fixture, through the km MCP tools (deterministic)', '')
  lines.push('| probe | characters |')
  lines.push('|---|---|')
  for (const [probe, chars] of Object.entries(report.outputSizes)) {
    lines.push(`| ${probe} | ${chars.toLocaleString('en-US')}${delta(chars, baseSize(probe))} |`)
  }
  lines.push('')

  return `${lines.join('\n')}\n`
}
