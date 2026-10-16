import { describe, expect, it } from 'vitest'
import { type EvalReport, renderMarkdown, summarize, type TaskRunRecord } from './report'

const runRecord = (task: string, rep: number, overrides: Partial<TaskRunRecord> = {}): TaskRunRecord => ({
  task,
  kind: 'read',
  rep,
  pass: true,
  detail: 'ok',
  toolCalls: 4,
  toolCallsByName: {mcp__km__search: 4},
  toolErrors: 0,
  toolResultBytes: 4096,
  maxToolResultBytes: 2048,
  cappedCalls: 0,
  returnedBytes: 4096,
  apiCalls: 5,
  tokens: {input: 10, cacheCreation: 1000, cacheRead: 9000, output: 300, contextTotal: 10_010, peakContext: 3000},
  durationMs: 10_000,
  costUsd: 0.02,
  terminalReason: 'completed',
  exitCode: 0,
  timedOut: false,
  writes: {created: 0, modified: 0},
  transcript: 't.jsonl',
  ...overrides,
})

const reportOf = (label: string, runs: TaskRunRecord[], taskHashes?: Record<string, string>): EvalReport => ({
  schemaVersion: 1,
  label,
  startedAt: '2026-10-15T00:00:00Z',
  finishedAt: '2026-10-15T00:10:00Z',
  git: {sha: '0123456789abcdef', branch: 'master', dirty: false},
  model: 'sonnet',
  resolvedModel: 'claude-test',
  effort: null,
  claudeCodeVersion: '1.0.0',
  kmTools: ['search'],
  mcpOutputTokens: 25_000,
  fixtureHash: 'abc',
  taskHashes: taskHashes ?? Object.fromEntries(runs.map(run => [run.task, `${run.task}-v1`])),
  outputSizes: {'search:x': 1000},
  runs,
})

describe('summarize', () => {
  it('takes per-task medians across repetitions and counts passes', () => {
    const [row] = summarize(reportOf('r', [
      runRecord('a', 1, {toolCalls: 2, pass: false}),
      runRecord('a', 2, {toolCalls: 10}),
      runRecord('a', 3, {toolCalls: 3}),
    ]))
    expect(row).toMatchObject({task: 'a', reps: 3, passes: 2, toolCalls: 3})
  })
})

describe('renderMarkdown', () => {
  it('puts deltas against the baseline beside each figure, and lists failures', () => {
    const baseline = reportOf('before', [runRecord('a', 1, {toolCalls: 8}), runRecord('b', 1)])
    const current = {
      ...reportOf('after', [runRecord('a', 1, {toolCalls: 4}), runRecord('b', 1, {pass: false, detail: 'missing [x]'})]),
      outputSizes: {'search:x': 250},
    }
    const markdown = renderMarkdown(current, baseline)
    expect(markdown).toContain('| a | read | 1/1 (was 1/1) | 4 (−50%) |')
    expect(markdown).toContain('| search:x | 250 (−75%) |')
    expect(markdown).toContain('- b #1: missing [x]')
  })

  it('totals a task subset against the same subset of the baseline', () => {
    const baseline = reportOf('before', [runRecord('a', 1, {toolCalls: 4}), runRecord('b', 1, {toolCalls: 100})])
    const markdown = renderMarkdown(reportOf('after', [runRecord('a', 1, {toolCalls: 4})]), baseline)
    expect(markdown).toContain('| **all** | | 1/1 | 4 (±0%) |')
  })

  it('keeps a task new to this report out of the aggregate delta', () => {
    const baseline = reportOf('before', [runRecord('a', 1, {toolCalls: 8})])
    const markdown = renderMarkdown(reportOf('after', [runRecord('a', 1, {toolCalls: 4}), runRecord('c', 1, {toolCalls: 50})]), baseline)
    expect(markdown).toContain('| **all** | | 2/2 | 54 |')
    expect(markdown).toContain('| **comparable (1)** | | 1/1 | 4 (−50%) |')
  })

  it('shows no delta for a task whose definition changed', () => {
    const baseline = reportOf('before', [runRecord('a', 1, {toolCalls: 8})])
    const current = reportOf('after', [runRecord('a', 1, {toolCalls: 4})], {a: 'a-v2'})
    const markdown = renderMarkdown(current, baseline)
    expect(markdown).toContain('| a | read | 1/1 (task changed since baseline) | 4 |')
    expect(markdown).not.toContain('(−50%)')
  })

  it('flags writes made during a read task', () => {
    const markdown = renderMarkdown(reportOf('r', [runRecord('a', 1, {writes: {created: 2, modified: 1}})]))
    expect(markdown).toContain('- a #1: 2 created, 1 modified')
  })
})
