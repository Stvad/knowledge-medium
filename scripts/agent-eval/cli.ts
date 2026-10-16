/**
 * Agent-ergonomics eval runner. See README.md in this directory.
 *
 *   pnpm agent-eval seed   [--profile km-eval]
 *   pnpm agent-eval run    [--profile km-eval] [--model sonnet] [--effort <level>] [--repeat 1]
 *                          [--tasks id,id] [--label <name>] [--compare <report.json>] [--timeout-min 10]
 *   pnpm agent-eval report <report.json> [--compare <report.json>]
 *   pnpm agent-eval sizes
 *
 * `run` spawns `claude -p` once per task with ONLY the km MCP tools, billed
 * to the CLI's subscription login (credential env scrubbed as agent-dispatch
 * does), against a local-only dev tab seeded with the fixture.
 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { type BridgeClient, createBridgeClient } from '../../packages/agent-cli/src/client'
import { KM_MCP_ALLOWED_TOOLS, KM_MCP_TOOL_NAMES, MCP_SERVER_NAME } from '../../packages/agent-cli/src/mcpShared'
import { runJsonlProcess } from '../../packages/agent-dispatch/src/execProcess'
import { BILLING_ENV_DENYLIST, envForBilling } from '../../packages/agent-dispatch/src/runner'
import { buildFixture, FIXTURE_HASH_PREFIX, FIXTURE_MARKER_PAGE } from './fixture'
import { childrenOf, type GraphProbe, pageIdByTitle } from './graphQueries'
import { restoreSnapshot, snapshotWorkspace, strayChanges } from './isolation'
import { createRunJournal } from './runJournal'
import { type EvalReport, renderMarkdown, type TaskRunRecord } from './report'
import { type EvalTask, targetId, taskDefinitionHash, TASKS } from './tasks'
import { extractAnswer, parseTranscript } from './transcript'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const RESULTS_DIR = path.join(REPO_ROOT, 'scripts/agent-eval/results')
const RUNS_DIR = path.join(REPO_ROOT, 'tmp/agent-eval/runs')
const MCP_ENTRY = path.join(REPO_ROOT, 'packages/agent-cli/dist/mcp.js')
const DEFAULT_PROFILE = 'km-eval'

const fail = (message: string): never => {
  process.stderr.write(`agent-eval: ${message}\n`)
  process.exit(1)
}

const connect = async (profile: string): Promise<{probe: GraphProbe, client: BridgeClient}> => {
  const client = createBridgeClient({profile, timeoutMs: 120_000})
  const who = await client.whoami().catch((error: unknown) =>
    fail(`cannot reach the bridge with profile "${profile}": ${error instanceof Error ? error.message : String(error)}\n`
      + 'Pair it against the local-only dev tab first (see scripts/agent-eval/README.md).'))
  if (!who.connected || !who.audience.workspaceId) fail(`profile "${profile}" has no connected tab`)
  if (who.scope !== 'read-write') fail(`profile "${profile}" is ${who.scope}; seeding and write tasks need read-write`)
  await requireNeverSynced(client, profile)
  return {
    client,
    probe: {workspaceId: who.audience.workspaceId!, command: command => client.runCommand(command)},
  }
}

/** Seeding and runs write thousands of blocks, so the tab must be one that
 *  has never synced: a local-only session holds no Supabase session, never
 *  connects PowerSync and never downloads a row. A signed-in tab — even
 *  offline, even before its first connect — shows at least one of these and
 *  is refused. Checked again before every task: a run can last hours. */
const requireNeverSynced = async (client: BridgeClient, profile: string) => {
  const status = await client.runCommand({
    type: 'eval',
    code: `const status = db.currentStatus
const {count} = await sql('SELECT count(*) AS count FROM blocks_synced', [], 'get')
return {signedIn: Object.keys(localStorage).some(key => /^sb-.+-auth-token$/.test(key)), connected: Boolean(status?.connected), connecting: Boolean(status?.connecting), hasSynced: Boolean(status?.hasSynced), lastSyncedAt: status?.lastSyncedAt ? String(status.lastSyncedAt) : null, syncedRows: count}`,
  }) as {signedIn: boolean, connected: boolean, connecting: boolean, hasSynced: boolean, lastSyncedAt: string | null, syncedRows: number}
  if (status.signedIn || status.connected || status.connecting || status.hasSynced || status.lastSyncedAt || status.syncedRows > 0) {
    fail(`profile "${profile}" is paired to a tab that syncs (${JSON.stringify(status)}). The eval writes to its graph, `
      + 'so it only runs against a local-only dev tab (README: "One-time setup").')
  }
}

/** The fixture hash the seeded graph carries, or null when it carries none. */
const seededHash = async (probe: GraphProbe): Promise<string | null> => {
  const markerId = await pageIdByTitle(probe, FIXTURE_MARKER_PAGE)
  if (!markerId) return null
  const line = (await childrenOf(probe, markerId)).find(row => row.content.startsWith(FIXTURE_HASH_PREFIX))
  return line ? line.content.slice(FIXTURE_HASH_PREFIX.length).trim() : null
}

const seed = async (profile: string) => {
  const {client, probe} = await connect(profile)
  const fixture = buildFixture()
  const existing = await seededHash(probe)
  if (existing && existing !== fixture.hash) {
    fail(`this workspace holds fixture ${existing}, not ${fixture.hash}. Re-importing a different fixture leaves the old `
      + 'blocks behind; seed a fresh local-only dev origin instead (README: "Resetting").')
  }
  process.stdout.write(`${existing ? 'Re-importing' : 'Importing'} fixture ${fixture.hash}…\n`)
  const summary = await client.runCommand({
    type: 'eval',
    data: fixture.pages,
    code: `const summary = await window.__omniliner.roamImport.run(data, {onProgress: () => {}})
return {blocksWritten: summary.blocksWritten, pagesDaily: summary.pagesDaily, durationMs: summary.durationMs, diagnostics: summary.diagnostics.length}`,
  }, {timeoutMs: 600_000})
  process.stdout.write(`${JSON.stringify(summary)}\n`)
}

const gitInfo = () => {
  const git = (...args: string[]) => spawnSync('git', args, {cwd: REPO_ROOT, encoding: 'utf8'}).stdout.trim()
  return {sha: git('rev-parse', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD'), dirty: git('status', '--porcelain') !== ''}
}

/** The runs launch the BUILT server, and a stale build silently measures old
 *  code, so every run builds first (incremental, a few seconds). */
const buildPackages = () => {
  process.stdout.write('building packages/agent-cli…\n')
  const build = spawnSync('pnpm', ['run', 'compile:packages'], {cwd: REPO_ROOT, encoding: 'utf8'})
  if (build.status !== 0) fail(`pnpm run compile:packages failed:\n${`${build.stdout}${build.stderr}`.trim().split('\n').slice(-15).join('\n')}`)
}

/** Deterministic sizes from the fixture-graph test; null if it could not run. */
const measureOutputSizes = (): Record<string, number> | null => {
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'agent-eval-sizes-')), 'sizes.json')
  spawnSync('pnpm', ['vitest', 'run', 'scripts/agent-eval/fixtureGraph.test.ts', '-t', 'output budgets'], {
    cwd: REPO_ROOT,
    env: {...process.env, AGENT_EVAL_SIZES_OUT: out},
    stdio: 'ignore',
  })
  return existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) as Record<string, number> : null
}

const writeMcpConfig = (dir: string, profile: string): string => {
  const file = path.join(dir, 'mcp.json')
  writeFileSync(file, JSON.stringify({
    mcpServers: {[MCP_SERVER_NAME]: {command: process.execPath, args: [MCP_ENTRY], env: {AGENT_RUNTIME_PROFILE: profile}}},
  }, null, 2))
  return file
}

const claudeArgs = (options: {model: string, effort: string | null, mcpConfig: string}) => [
  '-p', '--output-format', 'stream-json', '--verbose',
  '--model', options.model,
  ...(options.effort ? ['--effort', options.effort] : []),
  // Only our km server, only its tools, no built-in tools, and no user /
  // project settings (hooks, CLAUDE.md) leaking in from this machine.
  '--mcp-config', options.mcpConfig, '--strict-mcp-config',
  '--tools', '',
  '--allowedTools', KM_MCP_ALLOWED_TOOLS.join(','),
  '--setting-sources', '',
  '--no-session-persistence',
  '--permission-prompts', 'none',
]

interface RunOptions {
  profile: string
  model: string
  effort: string | null
  repeat: number
  tasks: readonly EvalTask[]
  label: string
  compare: string | null
  timeoutMs: number
  mcpOutputTokens: number
}

const run = async (options: RunOptions) => {
  buildPackages()
  const {probe, client} = await connect(options.profile)
  const fixture = buildFixture()
  const seeded = await seededHash(probe)
  if (seeded !== fixture.hash) {
    fail(seeded
      ? `the tab holds fixture ${seeded} but this checkout generates ${fixture.hash}; seed a fresh dev origin`
      : 'the tab has no fixture — run `pnpm agent-eval seed` first')
  }

  const runDir = path.join(RUNS_DIR, options.label)
  mkdirSync(path.join(runDir, 'transcripts'), {recursive: true})
  const mcpConfig = writeMcpConfig(runDir, options.profile)
  const scrubbed = BILLING_ENV_DENYLIST.filter(key => process.env[key])
  process.stdout.write(`billing: subscription login${scrubbed.length ? ` (scrubbed ${scrubbed.join(', ')})` : ''}\n`)

  const report: EvalReport = {
    schemaVersion: 1,
    label: options.label,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    git: gitInfo(),
    model: options.model,
    resolvedModel: null,
    effort: options.effort,
    claudeCodeVersion: null,
    kmTools: [...KM_MCP_TOOL_NAMES],
    mcpOutputTokens: options.mcpOutputTokens,
    fixtureHash: fixture.hash,
    taskHashes: Object.fromEntries(options.tasks.map(task => [task.id, taskDefinitionHash(task, fixture.truth)])),
    outputSizes: null,
    runs: [],
  }

  // Clear what an interrupted earlier run left, then freeze the starting
  // state every task gets: each task's changes are undone against it.
  const journal = createRunJournal(path.join(REPO_ROOT, 'tmp/agent-eval/journal', probe.workspaceId))
  const recovered = await journal.recover(probe, fixture.hash)
    .catch((error: unknown) => fail(`could not undo an interrupted run: ${error instanceof Error ? error.message : String(error)}`))
  if (recovered > 0) process.stdout.write(`undid ${recovered} change(s) an interrupted run left\n`)
  for (const task of TASKS) await task.reset?.({probe, truth: fixture.truth, runTag: ''})
  const snapshot = await snapshotWorkspace(probe)
  journal.begin(snapshot, fixture.hash)

  for (let rep = 1; rep <= options.repeat; rep++) {
    for (const task of options.tasks) {
      const env = {probe, truth: fixture.truth, runTag: randomBytes(2).toString('hex')}
      const cwd = mkdtempSync(path.join(tmpdir(), 'agent-eval-cwd-'))
      const transcriptPath = path.join(runDir, 'transcripts', `${task.id}-${rep}.jsonl`)
      let stdout = ''
      process.stdout.write(`[${rep}/${options.repeat}] ${task.id} … `)

      await requireNeverSynced(client, options.profile)
      const startedAt = Date.now()
      journal.taskStarted()
      const proc = await runJsonlProcess({
        bin: 'claude',
        args: claudeArgs({model: options.model, effort: options.effort, mcpConfig}),
        prompt: task.prompt(env),
        cwd,
        env: {...envForBilling(process.env, 'subscription'), MAX_MCP_OUTPUT_TOKENS: String(options.mcpOutputTokens)},
        timeoutMs: options.timeoutMs,
        onStdoutText: text => { stdout += text },
      })
      writeFileSync(transcriptPath, stdout)
      rmSync(cwd, {recursive: true, force: true})

      const metrics = parseTranscript(stdout)
      report.resolvedModel ??= metrics.model
      report.claudeCodeVersion ??= metrics.claudeCodeVersion
      const outcome = await task.check({...env, answer: extractAnswer(metrics.resultText), startedAt})
        .catch((error: unknown) => ({pass: false, detail: `check threw: ${error instanceof Error ? error.message : String(error)}`}))
      // Resolved before the undo, which removes what the task created.
      const allowed = {
        editIds: new Set((task.edits ?? []).map(uid => targetId(probe.workspaceId, uid))),
        createRoots: new Set(await task.createsUnder?.(env) ?? []),
      }
      const changes = await restoreSnapshot(probe, snapshot)
        .catch((error: unknown) => fail(`aborting the run: ${error instanceof Error ? error.message : String(error)}`))
      journal.taskRestored()
      const strayEdits = strayChanges(changes, allowed)
      const failures = [
        proc.timedOut ? 'timed out' : null,
        !proc.timedOut && (proc.exitCode !== 0 || metrics.isError) ? `claude exited ${proc.exitCode}${metrics.isError ? ' with an error result' : ''}` : null,
        strayEdits > 0 ? `changed ${strayEdits} block(s) it was not asked to` : null,
      ].filter((reason): reason is string => reason !== null)

      const outputs = metrics.toolCalls.map(call => call.outputBytes ?? 0)
      const record: TaskRunRecord = {
        task: task.id,
        kind: task.kind,
        rep,
        pass: outcome.pass && failures.length === 0,
        detail: [...failures, outcome.detail].join('; '),
        toolCalls: metrics.toolCalls.length,
        toolCallsByName: metrics.toolCalls.reduce<Record<string, number>>((counts, call) =>
          ({...counts, [call.name]: (counts[call.name] ?? 0) + 1}), {}),
        toolErrors: metrics.toolCalls.filter(call => call.isError).length,
        toolResultBytes: outputs.reduce((total, bytes) => total + bytes, 0),
        maxToolResultBytes: Math.max(0, ...outputs),
        cappedCalls: metrics.toolCalls.filter(call => call.capped).length,
        returnedBytes: metrics.toolCalls.reduce((total, call) => total + (call.returnedBytes ?? 0), 0),
        apiCalls: metrics.apiCalls,
        tokens: metrics.tokens,
        durationMs: metrics.durationMs,
        costUsd: metrics.costUsd,
        terminalReason: metrics.terminalReason,
        exitCode: proc.exitCode,
        timedOut: proc.timedOut,
        writes: {created: changes.created.length, modified: changes.modified.length},
        transcript: path.relative(REPO_ROOT, transcriptPath),
      }
      report.runs.push(record)
      process.stdout.write(`${record.pass ? 'pass' : 'FAIL'} · ${record.toolCalls} calls · `
        + `${Math.round(record.toolResultBytes / 1024)} KB read · ${Math.round(record.tokens.contextTotal / 1000)}k context tokens\n`)
      if (proc.exitCode !== 0 && proc.stderr.trim()) process.stdout.write(`    stderr: ${proc.stderr.trim().split('\n').slice(-3).join(' | ')}\n`)
    }
  }

  report.outputSizes = measureOutputSizes()
  journal.end()
  report.finishedAt = new Date().toISOString()
  writeReport(report, options.compare)
}

/** A label names files in results/, so it must stay a plain file name. */
const requireSafeLabel = (label: string) => {
  if (!/^[\w][\w.-]*$/.test(label)) fail(`label ${JSON.stringify(label)} must be letters, digits, '.', '_' or '-' (it names a file in results/)`)
}

const writeReport = (report: EvalReport, compare: string | null) => {
  requireSafeLabel(report.label)
  const baseline = compare ? JSON.parse(readFileSync(compare, 'utf8')) as EvalReport : undefined
  if (baseline && baseline.fixtureHash !== report.fixtureHash) {
    fail(`${compare} was measured on fixture ${baseline.fixtureHash}, this report on ${report.fixtureHash}; `
      + 'different graphs and truths make the deltas meaningless')
  }
  mkdirSync(RESULTS_DIR, {recursive: true})
  const base = path.join(RESULTS_DIR, report.label)
  writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`)
  const markdown = renderMarkdown(report, baseline)
  writeFileSync(`${base}.md`, markdown)
  process.stdout.write(`\n${markdown}\nwrote ${path.relative(REPO_ROOT, base)}.{json,md}\n`)
}

const main = async () => {
  const {positionals, values} = parseArgs({
    allowPositionals: true,
    options: {
      profile: {type: 'string', default: DEFAULT_PROFILE},
      model: {type: 'string', default: 'sonnet'},
      effort: {type: 'string'},
      repeat: {type: 'string', default: '1'},
      tasks: {type: 'string'},
      label: {type: 'string'},
      compare: {type: 'string'},
      'timeout-min': {type: 'string', default: '10'},
      // Pinned rather than inherited: it decides which results Claude Code
      // caps, so it is part of what a report measured.
      'mcp-output-tokens': {type: 'string', default: '25000'},
    },
  })
  const [command, ...rest] = positionals

  switch (command) {
    case 'seed':
      return seed(values.profile)
    case 'run': {
      const selected = values.tasks ? values.tasks.split(',').map(id => id.trim()) : null
      const tasks = selected ? TASKS.filter(task => selected.includes(task.id)) : TASKS
      if (selected && tasks.length !== selected.length) {
        fail(`unknown task id; known: ${TASKS.map(task => task.id).join(', ')}`)
      }
      const repeat = Number(values.repeat)
      const timeoutMin = Number(values['timeout-min'])
      if (!Number.isInteger(repeat) || repeat < 1 || repeat > 50) fail(`--repeat must be an integer from 1 to 50, got ${values.repeat}`)
      if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) fail(`--timeout-min must be a positive number, got ${values['timeout-min']}`)
      const mcpOutputTokens = Number(values['mcp-output-tokens'])
      if (!Number.isInteger(mcpOutputTokens) || mcpOutputTokens < 1) fail(`--mcp-output-tokens must be a positive integer, got ${values['mcp-output-tokens']}`)
      if (values.label) requireSafeLabel(values.label)
      const date = new Date().toISOString().slice(0, 10)
      return run({
        profile: values.profile,
        model: values.model,
        effort: values.effort ?? null,
        repeat,
        tasks,
        label: values.label ?? `${date}-${gitInfo().sha.slice(0, 7)}-${values.model}`,
        compare: values.compare ?? null,
        timeoutMs: timeoutMin * 60_000,
        mcpOutputTokens,
      })
    }
    case 'report': {
      if (!rest[0]) fail('usage: pnpm agent-eval report <report.json> [--compare <report.json>]')
      return writeReport(JSON.parse(readFileSync(rest[0], 'utf8')) as EvalReport, values.compare ?? null)
    }
    case 'sizes':
      process.stdout.write(`${JSON.stringify(measureOutputSizes(), null, 2)}\n`)
      return
    default:
      fail('usage: pnpm agent-eval <seed|run|report|sizes> — see scripts/agent-eval/README.md')
  }
}

await main()
