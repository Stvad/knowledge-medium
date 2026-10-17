/**
 * Agent-ergonomics eval runner. See README.md in this directory.
 *
 *   pnpm agent-eval run    [--surface mcp|cli] [--workers 4] [--model sonnet] [--effort <level>] [--repeat 1]
 *                          [--tasks id,id] [--label <name>] [--compare <report.json>] [--timeout-min 10]
 *   pnpm agent-eval report <report.json> [--compare <report.json>]
 *   pnpm agent-eval sizes
 *
 * `run` hosts the fixture graph in node behind a private bridge (hosting.ts)
 * and spawns `claude -p` once per task, each on a fresh copy of the graph and
 * with only the surface's tools, billed to the CLI's subscription login
 * (credential env scrubbed as agent-dispatch does).
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createBridgeClient } from '../../packages/agent-cli/src/client'
import { MCP_SERVER_NAME } from '../../packages/agent-cli/src/mcpShared'
import { runJsonlProcess } from '../../packages/agent-dispatch/src/execProcess'
import { BILLING_ENV_DENYLIST, envForBilling } from '../../packages/agent-dispatch/src/runner'
import { buildFixture, type Fixture } from './fixture'
import { fixtureState } from './fixtureState'
import { dailyNoteId, type GraphProbe, requirePageId } from './graphQueries'
import { type Bridge, envWithoutAgentRuntime, startBridge, startHost } from './hosting'
import { connectMcpClient } from './mcpClient'
import { measureProbes, OUTPUT_PROBES, outputProbeHash } from './outputBudgets'
import {
  conditionMismatches,
  definitionHash,
  type EvalReport,
  parseReport,
  renderMarkdown,
  REPORT_SCHEMA_VERSION,
  type TaskRunRecord,
} from './report'
import { allowedTools, SURFACE_NAMES, type SurfaceName, SURFACES, surfaceHash, toolArgs } from './surfaces'
import { diffAgainst, type Snapshot, snapshotWorkspace, strayChanges } from './taskChanges'
import { allowedChanges, type CheckOutcome, type EvalTask, taskDefinitionHash, TASKS } from './tasks'
import { extractAnswer, parseTranscript } from './transcript'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const RESULTS_DIR = path.join(REPO_ROOT, 'scripts/agent-eval/results')
const RUNS_DIR = path.join(REPO_ROOT, 'tmp/agent-eval/runs')
const AGENT_CLI_DIST = path.join(REPO_ROOT, 'packages/agent-cli/dist')
/** vite-node with the test config, which resolves `@/` the way the fixture
 *  test does. */
const HOST_COMMAND = {
  bin: path.join(REPO_ROOT, 'node_modules/.bin/vite-node'),
  args: ['--config', path.join(REPO_ROOT, 'vitest.config.ts'), path.join(REPO_ROOT, 'scripts/agent-eval/host.ts'), '--'],
}

const fail = (message: string): never => {
  process.stderr.write(`agent-eval: ${message}\n`)
  process.exit(1)
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

const loadReport = (file: string): EvalReport => {
  try {
    return parseReport(readFileSync(file, 'utf8'), file)
  } catch (error) {
    return fail(`cannot read report ${file}: ${errorText(error)}`)
  }
}

const gitInfo = () => {
  const git = (...args: string[]) => spawnSync('git', args, {cwd: REPO_ROOT, encoding: 'utf8'}).stdout.trim()
  return {sha: git('rev-parse', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD'), dirty: git('status', '--porcelain') !== ''}
}

/** The agent runs the BUILT CLI and MCP server, and a stale build silently
 *  measures old code, so every run builds first (incremental, a few seconds). */
const buildPackages = () => {
  process.stdout.write('building packages/agent-cli…\n')
  const build = spawnSync('pnpm', ['run', 'compile:packages'], {cwd: REPO_ROOT, encoding: 'utf8'})
  if (build.status !== 0) fail(`pnpm run compile:packages failed:\n${`${build.stdout}${build.stderr}`.trim().split('\n').slice(-15).join('\n')}`)
}

/** Of the code a task runs: the checkout, which each host loads as it
 *  starts, and the built CLI and MCP server, which a compile can change
 *  without leaving a source difference behind (an edit, a compile, a
 *  revert). A change while tasks run would hand some of them other code
 *  under this report's one git identity. */
const codeDigest = (): string => {
  // A listing cut off at the output buffer would hash only its start.
  const git = (...args: string[]): Buffer => {
    const result = spawnSync('git', args, {cwd: REPO_ROOT, maxBuffer: 2 ** 31})
    if (result.error || result.status !== 0) fail(`git ${args[0]} failed while fingerprinting the checkout: ${result.error?.message ?? result.stderr.toString().trim()}`)
    return result.stdout
  }
  const hash = createHash('sha256').update(git('rev-parse', 'HEAD')).update(git('diff', 'HEAD', '--binary'))
  const untracked = git('ls-files', '--others', '--exclude-standard', '-z').toString('utf8').split('\0').filter(Boolean)
  for (const file of untracked.sort()) hash.update(file).update(readFileSync(path.join(REPO_ROOT, file)))
  const built = (dir: string): void => {
    for (const entry of readdirSync(dir, {withFileTypes: true}).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) built(file)
      else hash.update(path.relative(AGENT_CLI_DIST, file)).update(readFileSync(file))
    }
  }
  built(AGENT_CLI_DIST)
  return hash.digest('hex')
}

/** The checker's view of one hosted graph: wire commands under its token. */
const probeFor = (bridge: Bridge, token: string, workspaceId: string) => {
  const client = createBridgeClient({bridgeUrl: bridge.url, token, timeoutMs: 120_000})
  return {client, probe: {workspaceId, command: command => client.runCommand(command)} satisfies GraphProbe}
}

interface Template {
  /** The closed database every task's graph is a copy of. */
  dir: string
  workspaceId: string
  rows: Snapshot
  /** `fixtureState`, hashed. */
  state: string
  /** Probe output sizes, characters. */
  outputs: Record<string, number>
}

/** Seeds the graph every task starts from, and measures it: its rows, its
 *  fixture state and the probes' output sizes. */
const prepareTemplate = async (bridge: Bridge, fixture: Fixture, logDir: string): Promise<Template> => {
  process.stdout.write('importing the fixture…\n')
  const host = await startHost({command: HOST_COMMAND, bridge, log: path.join(logDir, 'template.log')})
    .catch((error: unknown) => fail(errorText(error)))
  try {
    const whoami = await createBridgeClient({bridgeUrl: bridge.url, token: host.token}).whoami()
    const workspaceId = whoami.audience.workspaceId ?? fail('the template host registered no workspace')
    const {client, probe} = probeFor(bridge, host.token, workspaceId)
    const rows = await snapshotWorkspace(probe)
    const state = definitionHash(await fixtureState(probe, fixture.pages))
    const mcp = await connectMcpClient(client)
    const outputs = await measureProbes({
      callTool: mcp.callTool,
      pageId: title => requirePageId(probe, title),
      dailyNoteId: iso => dailyNoteId(probe, iso),
    }).finally(() => mcp.close())
    return {dir: host.dir, workspaceId, rows, state, outputs}
  } finally {
    await host.stop()
  }
}

/** Runs `kmagent` from the checkout's build, wherever the agent's shell is. */
const writeCliShim = (binDir: string) => {
  mkdirSync(binDir, {recursive: true})
  const shim = path.join(binDir, 'kmagent')
  writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(AGENT_CLI_DIST, 'cli.js'))} "$@"\n`, {mode: 0o755})
}

interface RunOptions {
  surface: SurfaceName
  workers: number
  model: string
  effort: string | null
  repeat: number
  tasks: readonly EvalTask[]
  label: string
  baseline: EvalReport | undefined
  timeoutMs: number
  mcpOutputTokens: number
  bashOutputChars: number
}

interface Job {
  task: EvalTask
  rep: number
}

const run = async (options: RunOptions) => {
  // Creating the run directory reserves the label; an empty one is given
  // back if the run stops before writing anything.
  const runDir = path.join(RUNS_DIR, options.label)
  const used = `label ${options.label} is already used; pass another --label, or delete its report and `
    + `${path.relative(REPO_ROOT, runDir)} to record over it`
  if (existsSync(path.join(RESULTS_DIR, `${options.label}.json`))) fail(used)
  mkdirSync(RUNS_DIR, {recursive: true})
  try {
    mkdirSync(runDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail(used)
    throw error
  }
  process.on('exit', () => {
    try {
      rmdirSync(runDir)
    } catch {
      // Not empty: the run wrote into it.
    }
  })
  buildPackages()
  const code = codeDigest()
  const fixture = buildFixture()
  const surface = SURFACES[options.surface]
  const scratch = mkdtempSync(path.join(tmpdir(), 'agent-eval-'))
  process.on('exit', () => rmSync(scratch, {recursive: true, force: true}))
  const bridge = await startBridge(path.join(AGENT_CLI_DIST, 'server.js'), path.join(scratch, 'bridge'))
    .catch((error: unknown) => fail(errorText(error)))
  process.on('exit', () => bridge.stop())
  mkdirSync(path.join(runDir, 'hosts'), {recursive: true})
  const template = await prepareTemplate(bridge, fixture, path.join(runDir, 'hosts'))
  process.on('exit', () => rmSync(template.dir, {recursive: true, force: true}))

  const report: EvalReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    label: options.label,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    git: gitInfo(),
    model: options.model,
    conditions: {
      fixture: fixture.hash,
      importedFixture: template.state,
      surface: options.surface,
      tools: surfaceHash(surface),
      model: null,
      effort: options.effort ?? 'default',
      mcpOutputTokens: options.mcpOutputTokens,
      bashOutputChars: options.bashOutputChars,
      timeoutMs: options.timeoutMs,
      workers: options.workers,
    },
    claudeCodeVersion: null,
    allowedTools: allowedTools(surface),
    taskHashes: Object.fromEntries(options.tasks.map(task => [task.id, taskDefinitionHash(task, fixture.truth)])),
    outputSizes: template.outputs,
    probeHashes: Object.fromEntries(OUTPUT_PROBES.map(probe => [probe.id, outputProbeHash(probe)])),
    runs: [],
  }
  // Checked before anything is spent, and again once the first task has
  // resolved the model.
  const requireComparable = (planned: boolean) => {
    const mismatches = options.baseline ? conditionMismatches(report, options.baseline, {planned}) : []
    if (mismatches.length > 0) throw new Error(`this run cannot be compared with ${options.baseline!.label}: they differ in ${mismatches.join('; ')}`)
  }
  try {
    requireComparable(true)
  } catch (error) {
    fail(errorText(error))
  }

  mkdirSync(path.join(runDir, 'transcripts'), {recursive: true})
  const binDir = path.join(scratch, 'bin')
  writeCliShim(binDir)
  const scrubbed = BILLING_ENV_DENYLIST.filter(key => process.env[key])
  process.stdout.write(`billing: subscription login${scrubbed.length ? ` (scrubbed ${scrubbed.join(', ')})` : ''}\n`)

  const jobs: Job[] = []
  for (let rep = 1; rep <= options.repeat; rep++) for (const task of options.tasks) jobs.push({task, rep})
  const records = new Map<Job, TaskRunRecord>()
  const abort = new AbortController()

  const runJob = async (job: Job): Promise<TaskRunRecord> => {
    const {task, rep} = job
    const jobDir = mkdtempSync(path.join(scratch, `${task.id}-${rep}-`))
    const cwd = path.join(jobDir, 'work')
    mkdirSync(cwd)
    const graph = await startHost({command: HOST_COMMAND, bridge, from: template.dir, log: path.join(runDir, 'hosts', `${task.id}-${rep}.log`)})
    try {
      const {probe} = probeFor(bridge, graph.token, template.workspaceId)
      // The agent's CLI and MCP server reach this graph and nothing else:
      // the private bridge, this graph's token, and a config dir with no
      // profiles in it.
      const runtimeEnv = {
        AGENT_RUNTIME_URL: bridge.url,
        AGENT_RUNTIME_TOKEN: graph.token,
        AGENT_RUNTIME_CONFIG_DIR: path.join(jobDir, 'agent-runtime'),
      }
      const mcpConfig = path.join(jobDir, 'mcp.json')
      writeFileSync(mcpConfig, JSON.stringify({
        mcpServers: surface.mcp
          ? {[MCP_SERVER_NAME]: {command: process.execPath, args: [path.join(AGENT_CLI_DIST, 'mcp.js')], env: runtimeEnv}}
          : {},
      }, null, 2))
      const transcriptPath = path.join(runDir, 'transcripts', `${task.id}-${rep}.jsonl`)
      let stdout = ''

      const startedAt = Date.now()
      const proc = await runJsonlProcess({
        bin: 'claude',
        args: [
          '-p', '--output-format', 'stream-json', '--verbose',
          '--model', options.model,
          ...(options.effort ? ['--effort', options.effort] : []),
          // Only the surface's tools, and no user / project settings (hooks,
          // CLAUDE.md) leaking in from this machine.
          '--mcp-config', mcpConfig, '--strict-mcp-config',
          ...toolArgs(surface),
          '--setting-sources', '',
          '--no-session-persistence',
          '--permission-prompts', 'none',
        ],
        prompt: `${surface.preamble}\n\n${task.prompt}`,
        cwd,
        env: {
          ...envForBilling(envWithoutAgentRuntime(process.env), 'subscription'),
          ...runtimeEnv,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
          MAX_MCP_OUTPUT_TOKENS: String(report.conditions.mcpOutputTokens),
          BASH_MAX_OUTPUT_LENGTH: String(report.conditions.bashOutputChars),
        },
        timeoutMs: report.conditions.timeoutMs,
        onStdoutText: text => { stdout += text },
        signal: abort.signal,
      })
      const elapsedMs = Date.now() - startedAt
      if (abort.signal.aborted) throw new Error('aborted')
      writeFileSync(transcriptPath, stdout)

      const metrics = parseTranscript(stdout)
      const modelResolved = report.conditions.model === null && metrics.model !== null
      if (!modelResolved && metrics.model !== null && metrics.model !== report.conditions.model) {
        throw new Error(`${task.id} ran on ${metrics.model}, not ${report.conditions.model} like the tasks before it; start the run again`)
      }
      report.conditions.model ??= metrics.model
      report.claudeCodeVersion ??= metrics.claudeCodeVersion
      if (modelResolved) requireComparable(false)
      const outcome: CheckOutcome = await task.check({probe, truth: fixture.truth, answer: extractAnswer(metrics.resultText), startedAt})
        .catch((error: unknown) => ({pass: false, detail: `check threw: ${errorText(error)}`}))
      const changes = await diffAgainst(probe, template.rows)
      // After the check, so a change while any part of this task ran is
      // caught before the task is accepted.
      if (codeDigest() !== code) throw new Error(`the checkout or the built agent CLI changed while ${task.id} ran, so it may have run other code; start the run again`)
      const strayEdits = strayChanges(changes, allowedChanges(task, probe.workspaceId, outcome))
      const failures = [
        proc.timedOut ? 'timed out' : null,
        !proc.timedOut && (proc.exitCode !== 0 || metrics.isError) ? `claude exited ${proc.exitCode}${metrics.isError ? ' with an error result' : ''}` : null,
        strayEdits > 0 ? `changed ${strayEdits} block(s) it was not asked to` : null,
      ].filter((reason): reason is string => reason !== null)

      const seen = metrics.toolCalls.map(call => call.seenChars ?? 0)
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
        seenChars: seen.reduce((total, chars) => total + chars, 0),
        maxSeenChars: Math.max(0, ...seen),
        cappedCalls: metrics.toolCalls.filter(call => call.capped).length,
        returnedChars: metrics.toolCalls.some(call => call.returnedChars === null)
          ? null : metrics.toolCalls.reduce((total, call) => total + (call.returnedChars ?? 0), 0),
        apiCalls: metrics.apiCalls,
        tokens: metrics.tokens,
        elapsedMs,
        costUsd: metrics.costUsd,
        terminalReason: metrics.terminalReason,
        exitCode: proc.exitCode,
        timedOut: proc.timedOut,
        writes: {created: changes.created.length, modified: changes.modified.length},
        transcript: path.relative(REPO_ROOT, transcriptPath),
      }
      if (proc.exitCode !== 0 && proc.stderr.trim()) {
        process.stdout.write(`    ${task.id} #${rep} stderr: ${proc.stderr.trim().split('\n').slice(-3).join(' | ')}\n`)
      }
      return record
    } finally {
      await graph.stop()
      rmSync(jobDir, {recursive: true, force: true})
    }
  }

  // The first failure stops the run: the other workers take no new job, and
  // the agents already running are killed.
  let next = 0
  let firstError: unknown = null
  const worker = async () => {
    while (!abort.signal.aborted && next < jobs.length) {
      const job = jobs[next++]
      try {
        const record = await runJob(job)
        records.set(job, record)
        process.stdout.write(`[${records.size}/${jobs.length}] ${job.task.id} #${job.rep} ${record.pass ? 'pass' : 'FAIL'} · ${record.toolCalls} calls · `
          + `${Math.round(record.seenChars / 1000)}k chars read · ${Math.round(record.tokens.contextTotal / 1000)}k context tokens · ${Math.round(record.elapsedMs / 1000)}s\n`)
      } catch (error) {
        firstError ??= error
        abort.abort()
      }
    }
  }
  process.stdout.write(`running ${jobs.length} task(s) on the ${options.surface} surface, ${options.workers} at a time…\n`)
  await Promise.all(Array.from({length: Math.min(options.workers, jobs.length)}, worker))
  if (firstError !== null) fail(`aborting the run: ${errorText(firstError)}`)

  report.runs = jobs.map(job => records.get(job)!)
  report.finishedAt = new Date().toISOString()
  writeReport(report, options.baseline)
  process.exit(0)
}

/** A label names files in results/, so it must stay a plain file name. */
const requireSafeLabel = (label: string) => {
  if (!/^[\w][\w.-]*$/.test(label)) fail(`label ${JSON.stringify(label)} must be letters, digits, '.', '_' or '-' (it names a file in results/)`)
}

const writeReport = (report: EvalReport, baseline: EvalReport | undefined) => {
  requireSafeLabel(report.label)
  mkdirSync(RESULTS_DIR, {recursive: true})
  const base = path.join(RESULTS_DIR, report.label)
  writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`)
  const markdown = renderMarkdown(report, baseline)
  writeFileSync(`${base}.md`, markdown)
  process.stdout.write(`\n${markdown}\nwrote ${path.relative(REPO_ROOT, base)}.{json,md}\n`)
}

const sizes = async () => {
  buildPackages()
  const scratch = mkdtempSync(path.join(tmpdir(), 'agent-eval-'))
  process.on('exit', () => rmSync(scratch, {recursive: true, force: true}))
  const bridge = await startBridge(path.join(AGENT_CLI_DIST, 'server.js'), path.join(scratch, 'bridge'))
    .catch((error: unknown) => fail(errorText(error)))
  process.on('exit', () => bridge.stop())
  const template = await prepareTemplate(bridge, buildFixture(), scratch)
  rmSync(template.dir, {recursive: true, force: true})
  process.stdout.write(`${JSON.stringify(template.outputs, null, 2)}\n`)
  process.exit(0)
}

const positiveInteger = (flag: string, raw: string, max = Number.MAX_SAFE_INTEGER): number => {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > max) fail(`--${flag} must be an integer from 1 to ${max}, got ${raw}`)
  return value
}

const main = async () => {
  const {positionals, values} = parseArgs({
    allowPositionals: true,
    options: {
      surface: {type: 'string', default: 'mcp'},
      workers: {type: 'string', default: '4'},
      model: {type: 'string', default: 'sonnet'},
      effort: {type: 'string'},
      repeat: {type: 'string', default: '1'},
      tasks: {type: 'string'},
      label: {type: 'string'},
      compare: {type: 'string'},
      'timeout-min': {type: 'string', default: '10'},
      // Pinned rather than inherited: they decide which results Claude Code
      // cuts short, so they are part of what a report measured.
      'mcp-output-tokens': {type: 'string', default: '25000'},
      'bash-output-chars': {type: 'string', default: '30000'},
    },
  })
  const [command, ...rest] = positionals

  switch (command) {
    case 'run': {
      const selected = values.tasks ? values.tasks.split(',').map(id => id.trim()) : null
      const tasks = selected ? TASKS.filter(task => selected.includes(task.id)) : TASKS
      if (selected && tasks.length !== selected.length) {
        fail(`unknown task id; known: ${TASKS.map(task => task.id).join(', ')}`)
      }
      const surface = values.surface as SurfaceName
      if (!SURFACE_NAMES.includes(surface)) fail(`--surface must be one of ${SURFACE_NAMES.join(', ')}, got ${values.surface}`)
      const timeoutMin = Number(values['timeout-min'])
      if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) fail(`--timeout-min must be a positive number, got ${values['timeout-min']}`)
      const now = new Date().toISOString()
      const label = values.label
        ?? `${now.slice(0, 10)}T${now.slice(11, 16).replace(':', '')}-${gitInfo().sha.slice(0, 7)}-${values.model.replace(/[^\w.-]/g, '-')}-${surface}`
      requireSafeLabel(label)
      return run({
        surface,
        workers: positiveInteger('workers', values.workers, 16),
        model: values.model,
        effort: values.effort ?? null,
        repeat: positiveInteger('repeat', values.repeat, 50),
        tasks,
        label,
        baseline: values.compare ? loadReport(values.compare) : undefined,
        timeoutMs: timeoutMin * 60_000,
        mcpOutputTokens: positiveInteger('mcp-output-tokens', values['mcp-output-tokens']),
        bashOutputChars: positiveInteger('bash-output-chars', values['bash-output-chars']),
      })
    }
    case 'report': {
      if (!rest[0]) fail('usage: pnpm agent-eval report <report.json> [--compare <report.json>]')
      return writeReport(loadReport(rest[0]), values.compare ? loadReport(values.compare) : undefined)
    }
    case 'sizes':
      return sizes()
    default:
      fail('usage: pnpm agent-eval <run|report|sizes> — see scripts/agent-eval/README.md')
  }
}

await main()
