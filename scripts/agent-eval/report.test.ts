import { describe, expect, it } from 'vitest'
import {
  conditionMismatches,
  type EvalReport,
  parseReport,
  renderMarkdown,
  type RunConditions,
  summarize,
  type TaskRunRecord,
} from './report'

const runRecord = (task: string, rep: number, overrides: Partial<TaskRunRecord> = {}): TaskRunRecord => ({
  task,
  kind: 'read',
  rep,
  pass: true,
  detail: 'ok',
  toolCalls: 4,
  toolCallsByName: {mcp__km__search: 4},
  toolErrors: 0,
  seenChars: 4096,
  maxSeenChars: 2048,
  cappedCalls: 0,
  returnedChars: 4096,
  apiCalls: 5,
  tokens: {input: 10, cacheCreation: 1000, cacheRead: 9000, output: 300, contextTotal: 10_010, peakContext: 3000},
  elapsedMs: 10_000,
  costUsd: 0.02,
  terminalReason: 'completed',
  exitCode: 0,
  timedOut: false,
  writes: {created: 0, modified: 0},
  transcript: 't.jsonl',
  ...overrides,
})

const reportOf = (
  label: string,
  runs: TaskRunRecord[],
  overrides: Partial<EvalReport> = {},
  conditions: Partial<RunConditions> = {},
): EvalReport => ({
  schemaVersion: 3,
  label,
  startedAt: '2026-10-15T00:00:00Z',
  finishedAt: '2026-10-15T00:10:00Z',
  git: {sha: '0123456789abcdef', branch: 'master', dirty: false},
  model: 'sonnet',
  conditions: {
    fixture: 'abc', importedFixture: 'state-1', model: 'claude-test', effort: 'default', mcpOutputTokens: 25_000, timeoutMs: 600_000,
    ...conditions,
  },
  claudeCodeVersion: '1.0.0',
  kmTools: ['search'],
  taskHashes: Object.fromEntries(runs.map(run => [run.task, `${run.task}-v1`])),
  outputSizes: {'search:x': 1000},
  probeHashes: {'search:x': 'x-v1'},
  runs,
  ...overrides,
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

  it('leaves a cost unknown when a repetition did not report one, rather than counting it as $0', () => {
    const [row] = summarize(reportOf('r', [
      runRecord('a', 1, {costUsd: 0.02}),
      runRecord('a', 2, {costUsd: null, timedOut: true, elapsedMs: 600_000}),
      runRecord('a', 3, {costUsd: 0.04}),
    ]))
    expect(row).toMatchObject({costUsd: null, elapsedMs: 10_000})
  })
})

describe('renderMarkdown', () => {
  it('puts deltas against the baseline beside each figure, and lists failures', () => {
    const baseline = reportOf('before', [runRecord('a', 1, {toolCalls: 8}), runRecord('b', 1)])
    const current = reportOf('after', [runRecord('a', 1, {toolCalls: 4}), runRecord('b', 1, {pass: false, detail: 'missing [x]'})], {
      outputSizes: {'search:x': 250},
    })
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
    const current = reportOf('after', [runRecord('a', 1, {toolCalls: 4})], {taskHashes: {a: 'a-v2'}})
    const markdown = renderMarkdown(current, baseline)
    expect(markdown).toContain('| a | read | 1/1 (task changed since baseline) | 4 |')
    expect(markdown).not.toContain('(−50%)')
  })

  it('shows no size delta for a probe whose call changed', () => {
    const baseline = reportOf('before', [runRecord('a', 1)])
    const current = reportOf('after', [runRecord('a', 1)], {outputSizes: {'search:x': 250}, probeHashes: {'search:x': 'x-v2'}})
    expect(renderMarkdown(current, baseline)).toContain('| search:x | 250 |')
  })

  it.each([
    ['model', {model: 'claude-other'}, 'model claude-test → claude-other'],
    ['effort', {effort: 'high'}, 'effort default → high'],
    ['MCP output cap', {mcpOutputTokens: 5_000}, 'mcpOutputTokens 25000 → 5000'],
    ['timeout', {timeoutMs: 60_000}, 'timeoutMs 600000 → 60000'],
    ['fixture', {fixture: 'def'}, 'fixture abc → def'],
    ['stored fixture', {importedFixture: 'state-2'}, 'importedFixture state-1 → state-2'],
  ] as const)('compares nothing with a baseline run under another %s', (_name, conditions, named) => {
    const baseline = reportOf('before', [runRecord('a', 1, {toolCalls: 8})])
    const current = reportOf('after', [runRecord('a', 1, {toolCalls: 4})], {outputSizes: {'search:x': 250}}, conditions)
    const markdown = renderMarkdown(current, baseline)
    expect(markdown).toContain(`**not compared** with before: the runs differ in ${named}`)
    expect(markdown).not.toContain('(was ')
    expect(markdown).not.toMatch(/\((?:[+−]\d+|±0)%\)/)
  })

  it('renders an unknown cost as n/a, in the task row and the total', () => {
    const markdown = renderMarkdown(reportOf('r', [runRecord('a', 1, {costUsd: null}), runRecord('b', 1)]))
    expect(markdown).toMatch(/^\| a \|.*\| n\/a \| 10s \|$/m)
    expect(markdown).toMatch(/^\| \*\*all\*\* \|.*\| n\/a \| 20s \|$/m)
  })

  it('flags writes made during a read task', () => {
    const markdown = renderMarkdown(reportOf('r', [runRecord('a', 1, {writes: {created: 2, modified: 1}})]))
    expect(markdown).toContain('- a #1: 2 created, 1 modified')
  })
})

describe('conditionMismatches', () => {
  it('leaves the model out before the run has resolved it', () => {
    const baseline = reportOf('before', [])
    expect(conditionMismatches(reportOf('after', [], {}, {model: null}), baseline, {planned: true})).toEqual([])
    expect(conditionMismatches(reportOf('after', [], {}, {model: null, mcpOutputTokens: 5}), baseline, {planned: true}))
      .toEqual(['mcpOutputTokens 25000 → 5'])
  })

  it('compares nothing with a recorded run whose model never resolved', () => {
    const baseline = reportOf('before', [])
    expect(conditionMismatches(reportOf('after', [], {}, {model: null}), baseline)).toEqual(['model claude-test → unknown'])
    expect(conditionMismatches(reportOf('after', [], {}, {model: null}), reportOf('before', [], {}, {model: null})))
      .toEqual(['model unknown → unknown'])
  })
})

describe('parseReport', () => {
  it('refuses a report written in another format', () => {
    expect(() => parseReport(JSON.stringify({...reportOf('old', []), schemaVersion: 1}), 'old.json'))
      .toThrow('old.json is report format 1, not 3')
  })
})
