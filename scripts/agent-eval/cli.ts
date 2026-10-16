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
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { type BridgeClient, createBridgeClient, resolveToken } from '../../packages/agent-cli/src/client'
import { agentRuntimeConfigDir } from '../../packages/agent-cli/src/config'
import { KM_MCP_ALLOWED_TOOLS, KM_MCP_TOOL_NAMES, MCP_SERVER_NAME } from '../../packages/agent-cli/src/mcpShared'
import { runJsonlProcess } from '../../packages/agent-dispatch/src/execProcess'
import { BILLING_ENV_DENYLIST, envForBilling } from '../../packages/agent-dispatch/src/runner'
import { buildFixture, type Fixture } from './fixture'
import { dailyNoteId, type GraphProbe, requirePageId } from './graphQueries'
import { restoreSnapshot, strayChanges } from './isolation'
import { connectMcpClient } from './mcpClient'
import { differingBlocks, fixtureState } from './fixtureState'
import { measureProbes, OUTPUT_PROBES, outputProbeHash } from './outputBudgets'
import { createRunJournal } from './runJournal'
import {
  conditionMismatches,
  type EvalReport,
  parseReport,
  renderMarkdown,
  REPORT_SCHEMA_VERSION,
  definitionHash,
  type TaskRunRecord,
} from './report'
import { allowedChanges, type CheckOutcome, type EvalTask, setupHash, taskDefinitionHash, TASKS } from './tasks'
import { extractAnswer, parseTranscript } from './transcript'
import { beginRun, openWorkspace } from './workspace'
import { acquireWorkspaceLock } from './workspaceLock'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const RESULTS_DIR = path.join(REPO_ROOT, 'scripts/agent-eval/results')
const RUNS_DIR = path.join(REPO_ROOT, 'tmp/agent-eval/runs')
// Beside the CLI's token store, so runs from every checkout on this machine
// share one lock and one journal per paired tab.
const EVAL_STATE_DIR = path.join(agentRuntimeConfigDir(), 'agent-eval')
const MCP_DIST = path.join(REPO_ROOT, 'packages/agent-cli/dist')
const MCP_ENTRY = path.join(MCP_DIST, 'mcp.js')
const DEFAULT_PROFILE = 'km-eval'

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

const tokenOf = async (profile: string): Promise<string> =>
  await resolveToken(profile) ?? fail(`profile "${profile}" has no token; pair it first (README: "One-time setup")`)

/** Which tab a token pairs with, without the secret: a profile's token
 *  changes when it is re-paired, and only then. */
const pairingOf = (token: string): string => createHash('sha256').update(token).digest('hex').slice(0, 16)

/** Keys the lock and the journal: a tab's audience (its user and workspace)
 *  is the same for every profile paired with it. Two tabs logged in under one
 *  name share an audience, and so a lock and a journal. */
const tabOf = (audience: {userId: string | null, workspaceId: string | null}): string =>
  createHash('sha256').update(`${audience.userId}\0${audience.workspaceId}`).digest('hex').slice(0, 16)

/** The runner's own client keeps the token it started with, so its checks and
 *  restores reach that tab even if the profile is re-paired meanwhile. */
const connect = async (profile: string): Promise<{probe: GraphProbe, client: BridgeClient, pairing: string, tab: string}> => {
  const token = await tokenOf(profile)
  const client = createBridgeClient({profile, token, timeoutMs: 120_000})
  const who = await client.whoami().catch((error: unknown) =>
    fail(`cannot reach the bridge with profile "${profile}": ${error instanceof Error ? error.message : String(error)}\n`
      + 'Pair it against the local-only dev tab first (see scripts/agent-eval/README.md).'))
  if (!who.connected || !who.audience.workspaceId) fail(`profile "${profile}" has no connected tab`)
  if (who.scope !== 'read-write') fail(`profile "${profile}" is ${who.scope}; seeding and write tasks need read-write`)
  await requireNeverSynced(client, profile)
  return {
    client,
    pairing: pairingOf(token),
    tab: tabOf(who.audience),
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

/** `seed` and `run` both write the graph: one at a time per workspace. */
const lockWorkspace = (tab: string): (() => void) => {
  try {
    return acquireWorkspaceLock(path.join(EVAL_STATE_DIR, tab, 'run.lock'))
  } catch (error) {
    return fail(errorText(error))
  }
}

/** Locks the workspace, then undoes what an earlier run left before the
 *  fixture marker is read (see `openWorkspace`). */
const prepareWorkspace = async (probe: GraphProbe, tab: string) => {
  const release = lockWorkspace(tab)
  const journal = createRunJournal(path.join(EVAL_STATE_DIR, tab, 'journal'))
  const {recovered, seeded} = await openWorkspace(probe, journal)
    .catch((error: unknown) => fail(`could not undo what an earlier run left: ${errorText(error)}`))
  if (recovered > 0) process.stdout.write(`undid ${recovered} change(s) an earlier run left\n`)
  return {release, journal, seeded}
}

const seed = async (profile: string) => {
  const {client, probe, tab} = await connect(profile)
  const fixture = buildFixture()
  const {release, seeded: existing} = await prepareWorkspace(probe, tab)
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
  release()
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

/** Of the code both halves of the tools run: the checkout, which the dev
 *  tab serves the app from, hot-reloading edits, and the built MCP server,
 *  which a compile can change without leaving a source difference behind (an
 *  edit, a compile, a revert). A change while a task runs would hand it other
 *  code under this report's one git identity. */
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
      else hash.update(path.relative(MCP_DIST, file)).update(readFileSync(file))
    }
  }
  built(MCP_DIST)
  return hash.digest('hex')
}

interface ImportedFixture {
  /** Probe output sizes, characters. */
  outputs: Record<string, number>
  state: string[]
}

/** The fixture as this checkout imports it, from the fixture-graph test;
 *  null unless the test passed and measured every probe. */
const importedFixture = (): ImportedFixture | null => {
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'agent-eval-sizes-')), 'sizes.json')
  const test = spawnSync('pnpm', ['vitest', 'run', 'scripts/agent-eval/fixtureGraph.test.ts', '-t', 'imported fixture'], {
    cwd: REPO_ROOT,
    env: {...process.env, AGENT_EVAL_SIZES_OUT: out},
    stdio: 'ignore',
  })
  if (test.status !== 0 || !existsSync(out)) return null
  const imported = JSON.parse(readFileSync(out, 'utf8')) as ImportedFixture
  return OUTPUT_PROBES.every(probe => imported.outputs[probe.id] !== undefined) && imported.state.length > 0 ? imported : null
}

/** The agent must query the graph this checkout's code imports, which the
 *  gate's checks are proven on, not one seeded by other code or left dirty.
 *  Returns the tab's probe output sizes. */
const requireImportedGraph = async (client: BridgeClient, probe: GraphProbe, fixture: Fixture): Promise<{outputs: Record<string, number>, state: string}> => {
  const expected = importedFixture()
    ?? fail('the in-process import to check the tab against failed; see pnpm vitest run scripts/agent-eval/fixtureGraph.test.ts -t "imported fixture"')
  const differing = differingBlocks(expected.state, await fixtureState(probe, fixture.pages))
  if (differing.length > 0) {
    fail(`the tab's fixture is not the one this checkout imports (${differing.length} block(s) differ, e.g. ${differing.slice(0, 5).join(', ')}); `
      + 'it was seeded by other code, or holds changes an earlier run left. Seed a fresh origin (README: "Resetting the dev origin").')
  }
  const mcp = await connectMcpClient(client)
  const outputs = await measureProbes({
    callTool: mcp.callTool,
    pageId: title => requirePageId(probe, title),
    dailyNoteId: iso => dailyNoteId(probe, iso),
  }).finally(() => mcp.close())
  return {outputs, state: definitionHash(expected.state)}
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
  baseline: EvalReport | undefined
  timeoutMs: number
  mcpOutputTokens: number
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
  const {probe, client, pairing, tab} = await connect(options.profile)
  const fixture = buildFixture()
  const {release, journal, seeded} = await prepareWorkspace(probe, tab)
  // Checked before each task and as soon as its agent exits, before the
  // check or the restore writes anything: the tab must still be local-only,
  // and the profile still paired with it, or the agent's MCP server (which
  // reads the profile afresh) may have written to another tab.
  const requireSameTab = async (when: string) => {
    await requireNeverSynced(client, options.profile)
    if (pairingOf(await tokenOf(options.profile)) !== pairing) {
      fail(`profile "${options.profile}" was paired with another tab ${when}; start the run again`)
    }
  }
  if (seeded !== fixture.hash) {
    fail(seeded
      ? `the tab holds fixture ${seeded} but this checkout generates ${fixture.hash}; seed a fresh dev origin`
      : 'the tab has no fixture — run `pnpm agent-eval seed` first')
  }

  const report: EvalReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    label: options.label,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    git: gitInfo(),
    model: options.model,
    conditions: {
      fixture: fixture.hash,
      importedFixture: null,
      setup: setupHash(),
      model: null,
      effort: options.effort ?? 'default',
      mcpOutputTokens: options.mcpOutputTokens,
      timeoutMs: options.timeoutMs,
    },
    claudeCodeVersion: null,
    kmTools: [...KM_MCP_TOOL_NAMES],
    taskHashes: Object.fromEntries(options.tasks.map(task => [task.id, taskDefinitionHash(task, fixture.truth)])),
    outputSizes: null,
    probeHashes: Object.fromEntries(OUTPUT_PROBES.map(probe => [probe.id, outputProbeHash(probe)])),
    runs: [],
  }
  // Checked before anything is spent, and again once the first task has
  // resolved the model.
  const requireComparable = (planned: boolean) => {
    const mismatches = options.baseline ? conditionMismatches(report, options.baseline, {planned}) : []
    if (mismatches.length > 0) fail(`this run cannot be compared with ${options.baseline!.label}: they differ in ${mismatches.join('; ')}`)
  }
  requireComparable(true)

  process.stdout.write('checking the tab against this checkout\'s import…\n')
  const {snapshot, setupCreated} = await beginRun(probe, journal, {
    validate: async () => {
      const imported = await requireImportedGraph(client, probe, fixture)
      report.outputSizes = imported.outputs
      report.conditions.importedFixture = imported.state
      requireComparable(true)
    },
    setUp: async () => { for (const task of TASKS) await task.reset?.({probe, truth: fixture.truth, runTag: ''}) },
  })

  mkdirSync(path.join(runDir, 'transcripts'), {recursive: true})
  const mcpConfig = writeMcpConfig(runDir, options.profile)
  const scrubbed = BILLING_ENV_DENYLIST.filter(key => process.env[key])
  process.stdout.write(`billing: subscription login${scrubbed.length ? ` (scrubbed ${scrubbed.join(', ')})` : ''}\n`)

  for (let rep = 1; rep <= options.repeat; rep++) {
    for (const task of options.tasks) {
      const env = {probe, truth: fixture.truth, runTag: randomBytes(2).toString('hex')}
      const cwd = mkdtempSync(path.join(tmpdir(), 'agent-eval-cwd-'))
      const transcriptPath = path.join(runDir, 'transcripts', `${task.id}-${rep}.jsonl`)
      let stdout = ''
      process.stdout.write(`[${rep}/${options.repeat}] ${task.id} … `)

      await requireSameTab('before this task')
      const startedAt = Date.now()
      journal.taskStarted()
      const proc = await runJsonlProcess({
        bin: 'claude',
        args: claudeArgs({model: options.model, effort: options.effort, mcpConfig}),
        prompt: task.prompt(env),
        cwd,
        env: {...envForBilling(process.env, 'subscription'), MAX_MCP_OUTPUT_TOKENS: String(report.conditions.mcpOutputTokens)},
        timeoutMs: report.conditions.timeoutMs,
        onStdoutText: text => { stdout += text },
      })
      const elapsedMs = Date.now() - startedAt
      await requireSameTab(`while ${task.id} ran`)
      writeFileSync(transcriptPath, stdout)
      rmSync(cwd, {recursive: true, force: true})

      const metrics = parseTranscript(stdout)
      const modelResolved = report.conditions.model === null && metrics.model !== null
      const modelChanged = !modelResolved && metrics.model !== null && metrics.model !== report.conditions.model
      report.conditions.model ??= metrics.model
      report.claudeCodeVersion ??= metrics.claudeCodeVersion
      const outcome: CheckOutcome = await task.check({...env, answer: extractAnswer(metrics.resultText), startedAt})
        .catch((error: unknown) => ({pass: false, detail: `check threw: ${errorText(error)}`}))
      const changes = await restoreSnapshot(probe, snapshot)
        .catch((error: unknown) => fail(`aborting the run: ${errorText(error)}`))
      // After the check and the restore, so a change while any of them ran, the
      // last task's included, is caught before the task is accepted.
      if (codeDigest() !== code) fail(`the checkout or the built MCP server changed while ${task.id} ran, so it may have run other code; start the run again`)
      journal.taskRestored()
      if (modelResolved) requireComparable(false)
      if (modelChanged) fail(`${task.id} ran on ${metrics.model}, not ${report.conditions.model} like the tasks before it; start the run again`)
      const allowed = allowedChanges(task, probe.workspaceId, outcome)
      const strayEdits = strayChanges(changes, allowed)
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
      report.runs.push(record)
      process.stdout.write(`${record.pass ? 'pass' : 'FAIL'} · ${record.toolCalls} calls · `
        + `${Math.round(record.seenChars / 1000)}k chars read · ${Math.round(record.tokens.contextTotal / 1000)}k context tokens\n`)
      if (proc.exitCode !== 0 && proc.stderr.trim()) process.stdout.write(`    stderr: ${proc.stderr.trim().split('\n').slice(-3).join(' | ')}\n`)
    }
  }

  await journal.end(probe, setupCreated)
  release()
  report.finishedAt = new Date().toISOString()
  writeReport(report, options.baseline)
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
      const now = new Date().toISOString()
      const label = values.label
        ?? `${now.slice(0, 10)}T${now.slice(11, 16).replace(':', '')}-${gitInfo().sha.slice(0, 7)}-${values.model.replace(/[^\w.-]/g, '-')}`
      requireSafeLabel(label)
      return run({
        profile: values.profile,
        model: values.model,
        effort: values.effort ?? null,
        repeat,
        tasks,
        label,
        baseline: values.compare ? loadReport(values.compare) : undefined,
        timeoutMs: timeoutMin * 60_000,
        mcpOutputTokens,
      })
    }
    case 'report': {
      if (!rest[0]) fail('usage: pnpm agent-eval report <report.json> [--compare <report.json>]')
      return writeReport(loadReport(rest[0]), values.compare ? loadReport(values.compare) : undefined)
    }
    case 'sizes': {
      const imported = importedFixture() ?? fail('the fixture-graph test failed; run it to see why')
      process.stdout.write(`${JSON.stringify(imported.outputs, null, 2)}\n`)
      return
    }
    default:
      fail('usage: pnpm agent-eval <seed|run|report|sizes> — see scripts/agent-eval/README.md')
  }
}

await main()
