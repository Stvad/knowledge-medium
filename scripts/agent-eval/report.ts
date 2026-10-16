/**
 * The eval's comparable output: one JSON record per task execution plus the
 * deterministic output sizes, and a markdown rendering that can put a
 * second report beside it as a baseline.
 */
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
  /** UTF-8 bytes of every tool result the agent read. */
  toolResultBytes: number
  maxToolResultBytes: number
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
  fixtureHash: string
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

export const renderMarkdown = (report: EvalReport, baseline?: EvalReport): string => {
  const rows = summarize(report)
  const base = new Map((baseline ? summarize(baseline) : []).map(row => [row.task, row]))
  const lines: string[] = []
  const reps = Math.max(...rows.map(row => row.reps))

  lines.push(`# Agent ergonomics eval — ${report.label}`, '')
  lines.push(`- commit \`${report.git.sha.slice(0, 10)}\` on \`${report.git.branch}\`${report.git.dirty ? ' (dirty tree)' : ''}`)
  lines.push(`- model \`${report.resolvedModel ?? report.model}\`${report.effort ? `, effort ${report.effort}` : ''}, Claude Code ${report.claudeCodeVersion ?? '?'}`)
  lines.push(`- km tools: ${report.kmTools.map(tool => `\`${tool}\``).join(', ')}`)
  lines.push(`- fixture \`${report.fixtureHash}\`, ${reps} repetition(s) per task; per-task figures are medians; lower is better except pass`)
  lines.push('- list $ is the API list-price equivalent the CLI reports (a subscription run is not charged it); it weights input, cache and output tokens in one number')
  if (baseline) lines.push(`- compared with **${baseline.label}** (commit \`${baseline.git.sha.slice(0, 10)}\`); deltas in parentheses`)
  lines.push('')

  lines.push('| task | kind | pass | tool calls | result bytes (total / max) | context tokens | peak context | output tokens | list $ | time |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|')
  for (const row of rows) {
    const was = base.get(row.task)
    lines.push(`| ${row.task} | ${row.kind} | ${row.passes}/${row.reps}${was ? ` (was ${was.passes}/${was.reps})` : ''} `
      + `| ${row.toolCalls}${delta(row.toolCalls, was?.toolCalls)} `
      + `| ${kb(row.toolResultBytes)}${delta(row.toolResultBytes, was?.toolResultBytes)} / ${kb(row.maxToolResultBytes)} `
      + `| ${thousands(row.contextTokens)}${delta(row.contextTokens, was?.contextTokens)} `
      + `| ${thousands(row.peakContext)}${delta(row.peakContext, was?.peakContext)} `
      + `| ${thousands(row.outputTokens)}${delta(row.outputTokens, was?.outputTokens)} `
      + `| ${dollars(row.costUsd)}${delta(row.costUsd, was?.costUsd)} `
      + `| ${seconds(row.durationMs)} |`)
  }
  const total = (pick: (row: TaskSummary) => number) => sum(rows.map(pick))
  const baseRows = [...base.values()]
  const baseTotal = (pick: (row: TaskSummary) => number) => (baseRows.length ? sum(baseRows.map(pick)) : undefined)
  lines.push(`| **all** | | ${total(row => row.passes)}/${total(row => row.reps)} `
    + `| ${total(row => row.toolCalls)}${delta(total(row => row.toolCalls), baseTotal(row => row.toolCalls))} `
    + `| ${kb(total(row => row.toolResultBytes))}${delta(total(row => row.toolResultBytes), baseTotal(row => row.toolResultBytes))} | `
    + `${thousands(total(row => row.contextTokens))}${delta(total(row => row.contextTokens), baseTotal(row => row.contextTokens))} | `
    + `| ${thousands(total(row => row.outputTokens))}${delta(total(row => row.outputTokens), baseTotal(row => row.outputTokens))} `
    + `| ${dollars(total(row => row.costUsd))}${delta(total(row => row.costUsd), baseTotal(row => row.costUsd))} `
    + `| ${seconds(total(row => row.durationMs))} |`)
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
      .map(([name, count]) => `${name.replace(/^mcp__km__/, '')} ×${count}`)
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
