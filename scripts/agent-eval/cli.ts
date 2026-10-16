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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createBridgeClient } from '../../packages/agent-cli/src/client'
import { KM_MCP_ALLOWED_TOOLS, MCP_SERVER_NAME } from '../../packages/agent-cli/src/mcpShared'
import type { KnownCommand } from '../../packages/agent-cli/src/protocol'
import { runJsonlProcess } from '../../packages/agent-dispatch/src/execProcess'
import { BILLING_ENV_DENYLIST, envForBilling } from '../../packages/agent-dispatch/src/runner'
import { buildFixture, FIXTURE_HASH_PREFIX, FIXTURE_MARKER_PAGE } from './fixture'
import { changedSince, childrenOf, type GraphProbe, pageIdByTitle } from './graphQueries'
import { type EvalReport, renderMarkdown, type TaskRunRecord } from './report'
import { type EvalTask, TASKS } from './tasks'
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

const connect = async (profile: string): Promise<{probe: GraphProbe, client: ReturnType<typeof createBridgeClient>}> => {
  const client = createBridgeClient({profile, timeoutMs: 120_000})
  const who = await client.whoami().catch((error: unknown) =>
    fail(`cannot reach the bridge with profile "${profile}": ${error instanceof Error ? error.message : String(error)}\n`
      + 'Pair it against the local-only dev tab first (see scripts/agent-eval/README.md).'))
  if (!who.connected || !who.audience.workspaceId) fail(`profile "${profile}" has no connected tab`)
  if (who.scope !== 'read-write') fail(`profile "${profile}" is ${who.scope}; seeding and write tasks need read-write`)
  return {
    client,
    probe: {workspaceId: who.audience.workspaceId!, command: command => client.runCommand(command as KnownCommand)},
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
  if (!existing) {
    // A fresh workspace carries a few system pages (and hundreds of system
    // blocks), so count the pages a person would have made.
    const [{count}] = await probe.command({
      type: 'sql', mode: 'all', params: [probe.workspaceId],
      sql: `SELECT count(*) AS count FROM blocks
        WHERE workspace_id = ? AND deleted = 0
          AND EXISTS (SELECT 1 FROM json_each(properties_json, '$.types') WHERE value = 'page')
          AND NOT EXISTS (SELECT 1 FROM json_each(properties_json, '$.types') WHERE value = 'daily-note')`,
    }) as Array<{count: number}>
    if (count > 20) fail(`workspace already holds ${count} pages and no fixture marker — refusing to import into what looks like real data`)
  }
  process.stdout.write(`${existing ? 'Re-importing (restores fixture blocks in place)' : 'Importing'} fixture ${fixture.hash}…\n`)
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

const newestMtime = (dir: string): number => readdirSync(dir, {withFileTypes: true, recursive: true})
  .filter(entry => entry.isFile())
  .reduce((newest, entry) => Math.max(newest, statSync(path.join(entry.parentPath, entry.name)).mtimeMs), 0)

/** The runs launch the BUILT server; a stale build silently measures old code. */
const requireFreshMcpBuild = () => {
  if (!existsSync(MCP_ENTRY)) fail('packages/agent-cli/dist/mcp.js is missing — run `pnpm run compile:packages`')
  if (newestMtime(path.join(REPO_ROOT, 'packages/agent-cli/src')) > statSync(MCP_ENTRY).mtimeMs) {
    fail('packages/agent-cli/dist is older than its src — run `pnpm run compile:packages`')
  }
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

/** Soft-delete what a write task created, outermost blocks first. */
const removeCreated = async (probe: GraphProbe, created: ReadonlyArray<{id: string, parent_id: string | null}>) => {
  const ids = new Set(created.map(row => row.id))
  for (const row of created) {
    if (row.parent_id && ids.has(row.parent_id)) continue
    await probe.command({type: 'delete-block', id: row.id}).catch(() => {})
  }
}

interface RunOptions {
  profile: string
  model: string
  effort: string | null
  repeat: number
  tasks: readonly EvalTask[]
  label: string
  compare: string | null
  timeoutMs: number
}

const run = async (options: RunOptions) => {
  requireFreshMcpBuild()
  const {probe} = await connect(options.profile)
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
    kmTools: [...KM_MCP_ALLOWED_TOOLS].map(tool => tool.replace(`mcp__${MCP_SERVER_NAME}__`, '')),
    fixtureHash: fixture.hash,
    outputSizes: null,
    runs: [],
  }

  // An interrupted earlier run can leave a task's edit behind; read tasks
  // must never see one.
  for (const task of TASKS) await task.reset?.({probe, truth: fixture.truth, runTag: ''})

  for (let rep = 1; rep <= options.repeat; rep++) {
    for (const task of options.tasks) {
      const env = {probe, truth: fixture.truth, runTag: randomBytes(2).toString('hex')}
      await task.reset?.(env)
      const cwd = mkdtempSync(path.join(tmpdir(), 'agent-eval-cwd-'))
      const transcriptPath = path.join(runDir, 'transcripts', `${task.id}-${rep}.jsonl`)
      let stdout = ''
      process.stdout.write(`[${rep}/${options.repeat}] ${task.id} … `)

      const startedAt = Date.now()
      const proc = await runJsonlProcess({
        bin: 'claude',
        args: claudeArgs({model: options.model, effort: options.effort, mcpConfig}),
        prompt: task.prompt(env),
        cwd,
        env: envForBilling(process.env, 'subscription'),
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
      const changes = await changedSince(probe, startedAt)
      const created = changes.filter(row => row.created_at >= startedAt)
      if (task.kind === 'write') {
        await removeCreated(probe, created)
        await task.reset?.(env)
      }

      const outputs = metrics.toolCalls.map(call => call.outputBytes ?? 0)
      const record: TaskRunRecord = {
        task: task.id,
        kind: task.kind,
        rep,
        pass: outcome.pass && !proc.timedOut,
        detail: proc.timedOut ? `timed out; ${outcome.detail}` : outcome.detail,
        toolCalls: metrics.toolCalls.length,
        toolCallsByName: metrics.toolCalls.reduce<Record<string, number>>((counts, call) =>
          ({...counts, [call.name]: (counts[call.name] ?? 0) + 1}), {}),
        toolErrors: metrics.toolCalls.filter(call => call.isError).length,
        toolResultBytes: outputs.reduce((total, bytes) => total + bytes, 0),
        maxToolResultBytes: Math.max(0, ...outputs),
        apiCalls: metrics.apiCalls,
        tokens: metrics.tokens,
        durationMs: metrics.durationMs,
        costUsd: metrics.costUsd,
        terminalReason: metrics.terminalReason,
        exitCode: proc.exitCode,
        timedOut: proc.timedOut,
        writes: {created: created.length, modified: changes.length - created.length},
        transcript: path.relative(REPO_ROOT, transcriptPath),
      }
      report.runs.push(record)
      process.stdout.write(`${record.pass ? 'pass' : 'FAIL'} · ${record.toolCalls} calls · `
        + `${Math.round(record.toolResultBytes / 1024)} KB read · ${Math.round(record.tokens.contextTotal / 1000)}k context tokens\n`)
      if (proc.exitCode !== 0 && proc.stderr.trim()) process.stdout.write(`    stderr: ${proc.stderr.trim().split('\n').slice(-3).join(' | ')}\n`)
    }
  }

  report.outputSizes = measureOutputSizes()
  report.finishedAt = new Date().toISOString()
  writeReport(report, options.compare)
}

const writeReport = (report: EvalReport, compare: string | null) => {
  const baseline = compare ? JSON.parse(readFileSync(compare, 'utf8')) as EvalReport : undefined
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
      const date = new Date().toISOString().slice(0, 10)
      return run({
        profile: values.profile,
        model: values.model,
        effort: values.effort ?? null,
        repeat: Math.max(1, Number(values.repeat)),
        tasks,
        label: values.label ?? `${date}-${gitInfo().sha.slice(0, 7)}-${values.model}`,
        compare: values.compare ?? null,
        timeoutMs: Number(values['timeout-min']) * 60_000,
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
