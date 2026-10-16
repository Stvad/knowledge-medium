/**
 * The eval's comparable output: one JSON record per task execution plus the
 * deterministic output sizes, and a markdown rendering that can put a
 * second report beside it as a baseline.
 */
import { MCP_SERVER_NAME } from '../../packages/agent-cli/src/mcpShared'
import type { TokenUsage } from './transcript'

export interface TaskRunRecord {
  task: string
  kind: 'read' | 'write'
  rep: number
  pass: boolean
  detail: string
  toolCalls: number
  toolCallsByName: Record<string, number>
  toolErrors: number
  /** UTF-8 bytes of every tool result the agent saw. */
  toolResultBytes: number
  maxToolResultBytes: number
  /** Results over Claude Code's MCP output cap, which the agent never saw. */
  cappedCalls: number
  /** What the tools returned, capped results at their real size. */
  returnedBytes: number
  apiCalls: number
  tokens: TokenUsage
  durationMs: number | null
  costUsd: number | null
  terminalReason: string | null
  exitCode: number | null
  timedOut: boolean
  /** Blocks the run created / changed, read from the graph afterwards. */
  writes: {created: number, modified: number}
  transcript: string
}

export interface EvalReport {
  schemaVersion: 1
  label: string
  startedAt: string
  finishedAt: string
  git: {sha: string, branch: string, dirty: boolean}
  model: string
  resolvedModel: string | null
  effort: string | null
  claudeCodeVersion: string | null
  kmTools: string[]
  /** MAX_MCP_OUTPUT_TOKENS the runs were given: it decides which results are capped. */
  mcpOutputTokens: number
  fixtureHash: string
  /** Per task, a hash of its definition (prompt, check, reset, allowed
   *  changes). Deltas are shown only for tasks whose hash matches. */
  taskHashes: Record<string, string>
  /** Deterministic output sizes (bytes) per probe, from the fixture-graph test. */
  outputSizes: Record<string, number> | null
  runs: TaskRunRecord[]
}

export interface TaskSummary {
  task: string
  kind: 'read' | 'write'
  reps: number
  passes: number
  toolCalls: number
  toolResultBytes: number
  maxToolResultBytes: number
  cappedCalls: number
  returnedBytes: number
  contextTokens: number
  peakContext: number
  outputTokens: number
  costUsd: number
  durationMs: number
}

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** Per task, medians across repetitions (pass count is a count). */
export const summarize = (report: EvalReport): TaskSummary[] => {
  const byTask = new Map<string, TaskRunRecord[]>()
  for (const run of report.runs) byTask.set(run.task, [...(byTask.get(run.task) ?? []), run])
  return [...byTask.entries()].map(([task, runs]) => ({
    task,
    kind: runs[0].kind,
    reps: runs.length,
    passes: runs.filter(run => run.pass).length,
    toolCalls: median(runs.map(run => run.toolCalls)),
    toolResultBytes: median(runs.map(run => run.toolResultBytes)),
    maxToolResultBytes: median(runs.map(run => run.maxToolResultBytes)),
    cappedCalls: median(runs.map(run => run.cappedCalls)),
    returnedBytes: median(runs.map(run => run.returnedBytes)),
    contextTokens: median(runs.map(run => run.tokens.contextTotal)),
    peakContext: median(runs.map(run => run.tokens.peakContext)),
    outputTokens: median(runs.map(run => run.tokens.output)),
    costUsd: median(runs.map(run => run.costUsd ?? 0)),
    durationMs: median(runs.map(run => run.durationMs ?? 0)),
  }))
}

const kb = (bytes: number) => (bytes >= 10_240 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024).toFixed(1)} KB`)
const thousands = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : `${(n / 1000).toFixed(1)}k`)
const seconds = (ms: number) => `${Math.round(ms / 1000)}s`
const dollars = (usd: number) => `$${usd.toFixed(3)}`

/** "+12%" / "−40%" against a baseline value; empty when there is none. */
const delta = (current: number, base: number | undefined): string => {
  if (base === undefined || base === 0) return ''
  const pct = Math.round(((current - base) / base) * 100)
  return pct === 0 ? ' (±0%)' : ` (${pct > 0 ? '+' : '−'}${Math.abs(pct)}%)`
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)

/** A figure with its delta against the baseline figure, when there is one. */
const cell = (format: (n: number) => string, current: number, base?: number) => `${format(current)}${delta(current, base)}`

const totalsRow = (label: string, rows: readonly TaskSummary[], baseRows?: readonly TaskSummary[]) => {
  const total = (from: readonly TaskSummary[], pick: (row: TaskSummary) => number) => sum(from.map(pick))
  const pair = (pick: (row: TaskSummary) => number) =>
    [total(rows, pick), baseRows ? total(baseRows, pick) : undefined] as const
  return `| ${label} | | ${total(rows, row => row.passes)}/${total(rows, row => row.reps)} `
    + `| ${cell(String, ...pair(row => row.toolCalls))} `
    + `| ${cell(String, ...pair(row => row.cappedCalls))} `
    + `| ${cell(kb, ...pair(row => row.toolResultBytes))} `
    + `| ${cell(kb, ...pair(row => row.returnedBytes))} `
    + `| ${cell(thousands, ...pair(row => row.contextTokens))} | `
    + `| ${cell(thousands, ...pair(row => row.outputTokens))} `
    + `| ${cell(dollars, ...pair(row => row.costUsd))} `
    + `| ${seconds(total(rows, row => row.durationMs))} |`
}

export const renderMarkdown = (report: EvalReport, baseline?: EvalReport): string => {
  const rows = summarize(report)
  const baselineRows = new Map((baseline ? summarize(baseline) : []).map(row => [row.task, row]))
  // Only a task measured on the same definition is comparable; a reworded
  // prompt or changed check is a different workload.
  const comparable = (task: string) => baselineRows.has(task)
    && baseline?.taskHashes?.[task] !== undefined && baseline.taskHashes[task] === report.taskHashes?.[task]
  const lines: string[] = []
  const reps = Math.max(...rows.map(row => row.reps))

  lines.push(`# Agent ergonomics eval — ${report.label}`, '')
  lines.push(`- commit \`${report.git.sha.slice(0, 10)}\` on \`${report.git.branch}\`${report.git.dirty ? ' (dirty tree)' : ''}`)
  lines.push(`- model \`${report.resolvedModel ?? report.model}\`${report.effort ? `, effort ${report.effort}` : ''}, Claude Code ${report.claudeCodeVersion ?? '?'}`)
  lines.push(`- km tools: ${report.kmTools.map(tool => `\`${tool}\``).join(', ')}; MCP output cap ${report.mcpOutputTokens} tokens`)
  lines.push('- "capped": results over that cap, which Claude Code replaced with a short notice; "seen" is what reached the model, "returned" what the tools produced')
  lines.push(`- fixture \`${report.fixtureHash}\`, ${reps} repetition(s) per task; per-task figures are medians; lower is better except pass`)
  lines.push('- list $ is the API list-price equivalent the CLI reports (a subscription run is not charged it); it weights input, cache and output tokens in one number')
  if (baseline) {
    lines.push(`- compared with **${baseline.label}** (commit \`${baseline.git.sha.slice(0, 10)}\`); deltas in parentheses, `
      + `for the ${rows.filter(row => comparable(row.task)).length} of ${rows.length} tasks whose definition is unchanged`)
  }
  lines.push('')

  lines.push('| task | kind | pass | tool calls | capped | bytes seen (total / max) | bytes returned | context tokens | peak context | output tokens | list $ | time |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const row of rows) {
    const was = comparable(row.task) ? baselineRows.get(row.task) : undefined
    const note = was ? ` (was ${was.passes}/${was.reps})` : baselineRows.has(row.task) ? ' (task changed since baseline)' : ''
    lines.push(`| ${row.task} | ${row.kind} | ${row.passes}/${row.reps}${note} `
      + `| ${cell(String, row.toolCalls, was?.toolCalls)} `
      + `| ${cell(String, row.cappedCalls, was?.cappedCalls)} `
      + `| ${cell(kb, row.toolResultBytes, was?.toolResultBytes)} / ${kb(row.maxToolResultBytes)} `
      + `| ${cell(kb, row.returnedBytes, was?.returnedBytes)} `
      + `| ${cell(thousands, row.contextTokens, was?.contextTokens)} `
      + `| ${cell(thousands, row.peakContext, was?.peakContext)} `
      + `| ${cell(thousands, row.outputTokens, was?.outputTokens)} `
      + `| ${cell(dollars, row.costUsd, was?.costUsd)} `
      + `| ${seconds(row.durationMs)} |`)
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
    for (const run of failures) lines.push(`- ${run.task} #${run.rep}: ${run.detail}${run.timedOut ? ' (timed out)' : ''}`)
    lines.push('')
  }

  const unexpectedWrites = report.runs.filter(run => run.kind === 'read' && run.writes.created + run.writes.modified > 0)
  if (unexpectedWrites.length > 0) {
    lines.push('## Writes during read tasks', '')
    for (const run of unexpectedWrites) lines.push(`- ${run.task} #${run.rep}: ${run.writes.created} created, ${run.writes.modified} modified`)
    lines.push('')
  }

  lines.push('## Tool use', '')
  lines.push('| task | calls by tool (all repetitions) | errors |')
  lines.push('|---|---|---|')
  for (const row of rows) {
    const counts: Record<string, number> = {}
    let errors = 0
    for (const run of report.runs.filter(item => item.task === row.task)) {
      errors += run.toolErrors
      for (const [name, count] of Object.entries(run.toolCallsByName)) counts[name] = (counts[name] ?? 0) + count
    }
    const rendered = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${name.replace(`mcp__${MCP_SERVER_NAME}__`, '')} ×${count}`)
      .join(', ')
    lines.push(`| ${row.task} | ${rendered || '—'} | ${errors} |`)
  }
  lines.push('')

  if (report.outputSizes) {
    lines.push('## Output sizes on the fixture (deterministic)', '')
    lines.push('| probe | bytes |')
    lines.push('|---|---|')
    for (const [probe, bytes] of Object.entries(report.outputSizes)) {
      lines.push(`| ${probe} | ${bytes.toLocaleString('en-US')}${delta(bytes, baseline?.outputSizes?.[probe])} |`)
    }
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}
