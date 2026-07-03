/**
 * Daemon configuration. One JSON file defines the watchers (what to
 * watch in the graph) and how spawned Claude runs are constrained.
 *
 * Default location: `<agent config dir>/claude-tasks.json`, i.e. next
 * to the kmagent token store (~/.config/knowledge-medium/).
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { agentRuntimeConfigDir, isErrnoException } from '@knowledge-medium/agent-cli/config'
import { normalizeProfileName } from '@knowledge-medium/agent-cli/client'
import { isReadOnlySql } from './mcpShared.js'

/** Block-property namespace the daemon owns. Kept short and stable —
 *  these live on user blocks and act as the durable task state. */
export const PROPS = {
  /** queued | running | done | error — presence means "seen". */
  status: 'claude:status',
  /** Claude Code session id for the thread (enables --resume). */
  session: 'claude:session',
  /** Watcher name that claimed the block. */
  watcher: 'claude:watcher',
  /** Last status-transition timestamp (ms). */
  updatedAt: 'claude:updated-at',
  /** How many times this task has been claimed (stale-running requeues
   *  bump it; MAX_ATTEMPTS in watchers.ts caps the retry loop). */
  attempts: 'claude:attempts',
  /** Error message for status=error. */
  error: 'claude:error',
  /** Marks daemon-authored reply blocks so watchers never re-trigger on them. */
  reply: 'claude:reply',
} as const

export type TaskStatus = 'queued' | 'running' | 'done' | 'error'

const watcherBase = {
  name: z.string().min(1),
  /** Prompt template; see prompt.ts for available {{placeholders}}. */
  prompt: z.string().optional(),
  /** Working directory for the spawned claude process. */
  cwd: z.string().optional(),
  /** EXTRA --allowedTools entries beyond the km MCP graph tools.
   *  Empty by default: mention tasks get graph access only, no Bash. */
  allowedTools: z.array(z.string()).default([]),
  model: z.string().optional(),
  /** Kill the claude run after this long. Capped WELL below the
   *  30-minute stale-running sweep (watchers.ts) so a live slow run is
   *  never concurrently re-claimed as crashed. */
  timeoutMs: z.number().int().positive().max(25 * 60_000).default(10 * 60_000),
  /** 'spawn' (default): one claude -p run per task, full lifecycle
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
   *  Capped at the tab-side settleMs bound (10min): the push watcher
   *  registers with settleMs = quietMs, and an over-cap value would
   *  fail the tab's schema — misdiagnosed as an unsupported bundle. */
  quietMs: z.number().int().nonnegative().max(600_000, 'quietMs above 600000 (10min) is not supported').default(15_000),
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
  tables: z.array(z.string().min(1)).max(8).optional(),
})

export const watcherSchema = z.discriminatedUnion('kind', [
  backlinksWatcherSchema,
  queryWatcherSchema,
])

export type BacklinksWatcher = z.infer<typeof backlinksWatcherSchema>
export type QueryWatcher = z.infer<typeof queryWatcherSchema>
export type Watcher = z.infer<typeof watcherSchema>

export const configSchema = z.strictObject({
  /** kmagent token profile the daemon pairs under. Keep it dedicated
   *  (not "default") so its access can be revoked independently.
   *  Validated here with the bridge client's own rules — an invalid
   *  name must be a CONFIG error (clean exit 0) rather than a later
   *  client throw that launchd restart-loops on. */
  profile: z.string().default('claude-tasks').refine(name => {
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
  maxConcurrent: z.number().int().positive().default(2),
  /** Global spend circuit-breaker: at most this many run launches
   *  (spawns or channel deliveries) per rolling hour, across all
   *  watchers. Converts any trigger-loop bug from an unbounded bill
   *  into a bounded one. */
  runsPerHour: z.number().int().positive().default(10),
  /** Loopback port the km MCP server's channel listener binds when the
   *  ambient session runs (watchers with delivery: 'channel' post here). */
  channelPort: z.number().int().positive().default(8790),
  /** State file for query-watcher cursors (backlink watchers keep
   *  their state as block properties in the graph itself). */
  statePath: z.string().optional(),
  /** Names must be unique: cursors, baselines, and in-flight run keys
   *  are all keyed by watcher name — duplicates would silently share
   *  state (e.g. the second watcher inherits the first one's cursor
   *  and skips its own baseline). */
  watchers: z.array(watcherSchema).default([]).refine(watchers => {
    const names = watchers.map(watcher => watcher.name)
    return new Set(names).size === names.length
  }, {message: 'duplicate watcher names — cursors and baselines are keyed by name, so each watcher needs its own'}),
})

export type DaemonConfig = z.infer<typeof configSchema>

export const defaultConfigPath = () =>
  path.join(agentRuntimeConfigDir(), 'claude-tasks.json')

export const defaultStatePath = () =>
  path.join(agentRuntimeConfigDir(), 'claude-tasks-state.json')

const expandHome = (value: string) =>
  value === '~' || value.startsWith('~/')
    ? path.join(os.homedir(), value.slice(1))
    : value

export const parseConfig = (raw: unknown): DaemonConfig => {
  const config = configSchema.parse(raw)
  return {
    ...config,
    statePath: config.statePath ? expandHome(config.statePath) : config.statePath,
    watchers: config.watchers.map(watcher => ({
      ...watcher,
      cwd: watcher.cwd ? expandHome(watcher.cwd) : watcher.cwd,
    })),
  }
}

export const loadConfig = async (configPath = defaultConfigPath()): Promise<DaemonConfig> => {
  let raw: string
  try {
    raw = await fs.readFile(configPath, 'utf8')
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      throw new Error(
        `No claude-tasks config at ${configPath}. Create it first — see packages/claude-tasks/README.md for the format.`,
        {cause: error},
      )
    }
    throw error
  }
  return parseConfig(JSON.parse(raw))
}
