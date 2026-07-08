/**
 * Daemon configuration. One JSON file defines the watchers (what to
 * watch in the graph) and how spawned agent runs are constrained.
 *
 * Default location: `<agent config dir>/agent-dispatch.json`, i.e. next
 * to the kmagent token store (~/.config/knowledge-medium/).
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { agentRuntimeConfigDir, isErrnoException } from '@knowledge-medium/agent-cli/config'
import { normalizeProfileName } from '@knowledge-medium/agent-cli/client'
import { WATCH_EVENTS_MAX_SETTLE_MS, WATCH_EVENTS_MAX_TABLES } from '@knowledge-medium/agent-cli/protocol'
import { isReadOnlySql } from '@knowledge-medium/agent-cli/mcpShared'

/** Block-property namespace the daemon owns. Kept short and stable —
 *  these live on user blocks and act as the durable task state. */
export const PROPS = {
  /** queued | running | done | error — presence means "seen". */
  status: 'agent:status',
  /** Executor session/thread id (enables resume where supported). */
  session: 'agent:session',
  /** Watcher name that claimed the block. */
  watcher: 'agent:watcher',
  /** Executor that claimed the block, used by synced UI chips. */
  executor: 'agent:executor',
  /** Last status-transition timestamp (ms). */
  updatedAt: 'agent:updated-at',
  /** How many times this task has been claimed (stale-running requeues
   *  bump it; MAX_ATTEMPTS in watchers.ts caps the retry loop). */
  attempts: 'agent:attempts',
  /** Error message for status=error. */
  error: 'agent:error',
  /** Marks daemon-authored reply blocks so watchers never re-trigger on them. */
  reply: 'agent:reply',
  /** Transient "what the run is doing right now" label (e.g. a tool
   *  name humanized by the runner's stream-json parser). Cleared
   *  (written as '') on every terminal status write so a stale label
   *  never outlives the run. */
  activity: 'agent:activity',
  /** Cancellation REQUEST written by the UI (companion Stop action) on a
   *  running block. The daemon owns the child process, so it can't be
   *  killed from the app — this is the graph signal: the daemon sees it,
   *  aborts the run, parks the task `error: cancelled`, and clears this
   *  (written as '') on the terminal write so it never re-cancels a rerun. */
  cancel: 'agent:cancel',
} as const

export type TaskStatus = 'queued' | 'running' | 'done' | 'error'
export type Executor = 'claude' | 'codex'

const runnerBase = {
  /** Working directory for the spawned agent process. */
  cwd: z.string().optional(),
  model: z.string().optional(),
  /** Kill the agent run after this long. Capped WELL below the
   *  30-minute stale-running sweep (watchers.ts) so a live slow run is
   *  never concurrently re-claimed as crashed. */
  timeoutMs: z.number().int().positive().max(25 * 60_000).default(10 * 60_000),
}

const claudeRunnerSchema = z.strictObject({
  executor: z.literal('claude'),
  ...runnerBase,
  /** EXTRA --allowedTools entries beyond the km MCP graph tools.
   *  Empty by default: mention tasks get graph access only, no Bash. */
  allowedTools: z.array(z.string()).default([]),
})

const codexSandboxSchema = z.enum(['read-only', 'workspace-write', 'danger-full-access'])
const codexApprovalPolicySchema = z.enum(['on-request', 'never'])
const codexApprovalsReviewerSchema = z.enum(['auto_review'])

const codexRunnerSchema = z.strictObject({
  executor: z.literal('codex'),
  ...runnerBase,
  /** Codex's own sandbox. Defaults to the historical dispatch posture:
   *  shell commands may read, but not write, the local filesystem. */
  sandbox: codexSandboxSchema.default('read-only'),
  /** Additional writable roots passed as `--add-dir`. Only meaningful
   *  once the sandbox can write. */
  addDirs: z.array(z.string()).default([]),
  /** Enables `[sandbox_workspace_write].network_access` for this run.
   *  Codex only exposes that network toggle for workspace-write. */
  networkAccess: z.boolean().default(false),
  /** Headless dispatch defaults to never asking. Codex exec ignores the
   *  interactive `-a` path; on-request is only supported when routed to
   *  the auto-review classifier via `approvalsReviewer: "auto_review"`. */
  approvalPolicy: codexApprovalPolicySchema.default('never'),
  approvalsReviewer: codexApprovalsReviewerSchema.optional(),
})

const runnerSchema = z.preprocess(
  value => value === undefined ? {executor: 'claude'} : value,
  z.discriminatedUnion('executor', [claudeRunnerSchema, codexRunnerSchema]),
).superRefine((runner, ctx) => {
  if (runner.executor !== 'codex') return
  if (runner.networkAccess && runner.sandbox !== 'workspace-write') {
    ctx.addIssue({
      code: 'custom',
      path: ['networkAccess'],
      message: 'networkAccess is only supported with sandbox="workspace-write"',
    })
  }
  if (runner.addDirs.length > 0 && runner.sandbox === 'read-only') {
    ctx.addIssue({
      code: 'custom',
      path: ['addDirs'],
      message: 'addDirs requires sandbox="workspace-write" or "danger-full-access"',
    })
  }
  if (runner.approvalPolicy !== 'never' && runner.approvalsReviewer !== 'auto_review') {
    ctx.addIssue({
      code: 'custom',
      path: ['approvalPolicy'],
      message: 'Codex exec only supports non-never approvalPolicy with approvalsReviewer="auto_review"',
    })
  }
  if (runner.approvalsReviewer === 'auto_review' && runner.approvalPolicy !== 'on-request') {
    ctx.addIssue({
      code: 'custom',
      path: ['approvalsReviewer'],
      message: 'approvalsReviewer="auto_review" requires approvalPolicy="on-request"',
    })
  }
})

export type Runner = z.infer<typeof runnerSchema>
export type CodexSandbox = z.infer<typeof codexSandboxSchema>
export type CodexApprovalPolicy = z.infer<typeof codexApprovalPolicySchema>
export type CodexApprovalsReviewer = z.infer<typeof codexApprovalsReviewerSchema>

const watcherBase = {
  name: z.string().min(1),
  /** Keep a watcher parked in the config without registering it,
   *  blocking its target wikilinks, or spending on it. Disabled entries
   *  still parse as normal watchers so config drift is visible early. */
  disabled: z.boolean().default(false),
  /** Prompt template; see prompt.ts for available {{placeholders}}. */
  prompt: z.string().optional(),
  /** Runner-specific process config. Kept nested so Claude's
   *  allowlisted tools and Codex's sandbox/approval controls cannot
   *  silently apply to the wrong executor. */
  runner: runnerSchema,
  /** 'spawn' (default): one CLI run per task, full lifecycle
   *  handled by the daemon. 'channel' (EXPERIMENTAL, research-preview
   *  Claude Code channels): push the event into a persistent ambient
   *  session via the km MCP channel port; that session completes the
   *  lifecycle itself using the graph tools. */
  delivery: z.enum(['spawn', 'channel']).default('spawn'),
}

const backlinksWatcherSchema = z.strictObject({
  ...watcherBase,
  kind: z.literal('backlinks'),
  /** Page alias whose NEW backlinks become tasks (e.g. "claude"). */
  target: z.string().min(1),
  /** Resume the nearest ancestor thread session when present. */
  resume: z.boolean().default(true),
  /** Don't claim a mention until the block has been quiet this long —
   *  otherwise the daemon snapshots (and bills) a half-typed request.
   *  Capped at the tab-side settleMs bound: the push watcher registers
   *  with settleMs = quietMs, and an over-cap value would fail the
   *  tab's schema — misdiagnosed as an unsupported bundle. */
  quietMs: z.number().int().nonnegative()
    .max(WATCH_EVENTS_MAX_SETTLE_MS, `quietMs above ${WATCH_EVENTS_MAX_SETTLE_MS} (10min) is not supported`)
    .default(15_000),
  /** Stream the in-progress reply text into the reply block as the run
   *  goes, instead of posting it only once at the end. Writes are
   *  throttled to ~1.5s apart — each one is a synced graph mutation, so
   *  leave this off for watchers where that churn matters. */
  streamReply: z.boolean().default(false),
})

const queryWatcherSchema = z.strictObject({
  ...watcherBase,
  kind: z.literal('query'),
  /** Read-only SQL run through the bridge; rows must expose an `id`
   *  column — new ids (vs the state file) trigger a run. Enforced at
   *  parse time: the bridge's sql mode doesn't gate writes, so a
   *  mutating statement here would EXECUTE on every poll. */
  sql: z.string().min(1).refine(isReadOnlySql, {
    message: 'watcher SQL must be a single read-only statement (SELECT, or WITH without mutating keywords); it runs on every poll',
  }),
  params: z.array(z.unknown()).default([]),
  /** Cap on rows folded into one prompt; overflow is summarized. */
  maxRowsPerFire: z.number().int().positive().default(100),
  /** Tables whose changes re-run the query for PUSH detection (the
   *  in-tab watch-events registration; default: blocks). The polling
   *  sweep ignores this. */
  tables: z.array(z.string().min(1)).max(WATCH_EVENTS_MAX_TABLES).optional(),
})

const rawWatcherSchema = z.discriminatedUnion('kind', [
  backlinksWatcherSchema,
  queryWatcherSchema,
])

type RawBacklinksWatcher = z.infer<typeof backlinksWatcherSchema>
type RawQueryWatcher = z.infer<typeof queryWatcherSchema>
type RawWatcher = z.infer<typeof rawWatcherSchema>

type ActiveWatcher<T extends {disabled: boolean}> = Omit<T, 'disabled'>

export type BacklinksWatcher = ActiveWatcher<RawBacklinksWatcher>
export type QueryWatcher = ActiveWatcher<RawQueryWatcher>
export type Watcher = BacklinksWatcher | QueryWatcher

const rawConfigSchema = z.strictObject({
  /** kmagent token profile the daemon pairs under. Keep it dedicated
   *  (not "default") so its access can be revoked independently.
   *  Validated here with the bridge client's own rules — an invalid
   *  name must be a CONFIG error (clean exit 0) rather than a later
   *  client throw that launchd restart-loops on. */
  profile: z.string().default('agent-dispatch').refine(name => {
    try {
      normalizeProfileName(name)
      return true
    } catch {
      return false
    }
  }, {message: 'profile names may only contain letters, numbers, underscores, dots, and dashes'}),
  /** Sweep cadence. With push active (see `push`) this is only the
   *  correctness backstop — 30s is plenty; without push it is the
   *  detection latency, so keep it low. */
  pollIntervalMs: z.number().int().positive().default(5_000),
  /** Register in-tab watch-events watchers and react to their settle
   *  events immediately, demoting the poll to a slow sweep. Falls back
   *  to pure polling when the tab/bridge doesn't support it. */
  push: z.boolean().default(true),
  claudeBin: z.string().default('claude'),
  /** Path/name of the codex CLI, for watchers with `runner.executor: 'codex'`. */
  codexBin: z.string().default('codex'),
  /** Which account a run's tokens bill to. 'subscription' (default,
   *  safe): scrub every API-key/token/provider-reroute env var from the
   *  child so an ambient key can't SILENTLY redirect an unattended
   *  daemon onto usage-based billing — the CLI's plan login (OAuth) then
   *  wins. 'api': deliberately opt IN to usage-based billing/credits —
   *  the scrub is skipped and the CLI uses whatever credential the env
   *  or login provides. Making it a config field (not an env accident)
   *  is the point: possible on purpose, hard by accident. NB: a key
   *  stored via `claude`/`codex` login (auth.json / apiKeyHelper) lives
   *  outside the env and CANNOT be scrubbed — see the startup log. */
  billing: z.enum(['subscription', 'api']).default('subscription'),
  /** Tools EVERY spawned Claude run may use, beyond the km MCP graph
   *  tools; per-watcher `runner.allowedTools` adds on top. Defaults to
   *  web research (WebSearch + WebFetch) — the common "look this up for
   *  me" mention needs it, and neither tool touches the local machine.
   *  TRADE-OFF: WebFetch ingests arbitrary page text, so a
   *  prompt-injected page can steer a run that also holds graph WRITE
   *  tools — including exfiltrating note content through crafted fetch
   *  URLs. Accepted default here; set `defaultAllowedTools: []` to run
   *  Claude graph-only. */
  defaultAllowedTools: z.array(z.string()).default(['WebSearch', 'WebFetch']),
  maxConcurrent: z.number().int().positive().default(2),
  /** Global spend circuit-breaker: at most this many run launches
   *  (spawns or channel deliveries) per rolling hour, across all
   *  watchers. Converts any trigger-loop bug from an unbounded bill
   *  into a bounded one. */
  runsPerHour: z.number().int().positive().default(10),
  /** Loopback port the dispatch channel MCP listener binds when the
   *  ambient session runs (watchers with delivery: 'channel' post here). */
  channelPort: z.number().int().positive().default(8790),
  /** State file for query-watcher cursors (backlink watchers keep
   *  their state as block properties in the graph itself). */
  statePath: z.string().optional(),
  /** Names must be unique across the whole config: cursors, baselines,
   *  and in-flight run keys are all keyed by watcher name, so even a
   *  disabled watcher reserves its name against accidental state reuse. */
  watchers: z.array(rawWatcherSchema).default([]),
}).superRefine((config, ctx) => {
  const duplicateName = duplicateWatcherName(config.watchers)
  if (duplicateName) {
    ctx.addIssue({
      code: 'custom',
      path: ['watchers'],
      message: `duplicate watcher name "${duplicateName}" — cursors and baselines are keyed by watcher name, so each watcher needs its own even when disabled`,
    })
  }
  config.watchers.forEach((watcher, index) => {
    if (watcher.delivery === 'channel' && watcher.runner.executor !== 'claude') {
      ctx.addIssue({
        code: 'custom',
        path: ['watchers', index, 'delivery'],
        message: 'delivery="channel" requires runner.executor="claude"; Codex has no channel transport',
      })
    }
  })
})

export const defaultConfigPath = () =>
  path.join(agentRuntimeConfigDir(), 'agent-dispatch.json')

export const defaultStatePath = () =>
  path.join(agentRuntimeConfigDir(), 'agent-dispatch-state.json')

const expandHome = (value: string) =>
  value === '~' || value.startsWith('~/')
    ? path.join(os.homedir(), value.slice(1))
    : value

const duplicateWatcherName = (watchers: RawWatcher[]): string | null => {
  const seen = new Set<string>()
  for (const watcher of watchers) {
    if (seen.has(watcher.name)) return watcher.name
    seen.add(watcher.name)
  }
  return null
}

const toActiveWatcher = (rawWatcher: RawWatcher): Watcher => {
  const {disabled, ...watcher} = rawWatcher
  void disabled
  const runner = watcher.runner
  return {
    ...watcher,
    runner: {
      ...runner,
      cwd: runner.cwd ? expandHome(runner.cwd) : runner.cwd,
      ...(runner.executor === 'codex'
        ? {addDirs: runner.addDirs.map(expandHome)}
        : {}),
    },
  }
}

export const configSchema = rawConfigSchema.transform(config => {
  const activeWatchers = config.watchers.filter(watcher => !watcher.disabled)
  return {
    ...config,
    /** Raw watcher-entry count before `disabled` filtering. The daemon
     *  needs this to distinguish an empty config from a deliberately
     *  parked all-disabled config, while runtime consumers still see
     *  only active watchers in `watchers`. */
    configuredWatcherCount: config.watchers.length,
    statePath: config.statePath ? expandHome(config.statePath) : config.statePath,
    watchers: activeWatchers.map(toActiveWatcher),
  }
})

export type DaemonConfig = z.infer<typeof configSchema>

export const parseConfig = (raw: unknown): DaemonConfig =>
  configSchema.parse(raw)

export const loadConfig = async (configPath = defaultConfigPath()): Promise<DaemonConfig> => {
  let raw: string
  try {
    raw = await fs.readFile(configPath, 'utf8')
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      throw new Error(
        `No agent-dispatch config at ${configPath}. Create it first — see packages/agent-dispatch/README.md for the format.`,
        {cause: error},
      )
    }
    throw error
  }
  return parseConfig(JSON.parse(raw))
}
