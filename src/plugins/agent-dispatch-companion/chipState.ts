/**
 * Pure decision logic for the Agent status chip: block properties →
 * chip descriptor. The property protocol is owned by the agent-dispatch
 * daemon (packages/agent-dispatch/src/config.ts PROPS) — property names
 * are duplicated here because this browser-side projection consumes the
 * daemon-owned graph fields.
 */
import { BRIDGE_COMMAND_TIMEOUT_MS } from '@knowledge-medium/agent-cli/protocol'
import type { KmMcpToolName } from '@knowledge-medium/agent-cli/mcpShared'

export const AGENT_PROPS = {
  status: 'agent:status',
  executor: 'agent:executor',
  watcher: 'agent:watcher',
  watcherKind: 'agent:watcher-kind',
  /** Executor session/thread id. Codex threads are stored as `codex:<id>`. */
  session: 'agent:session',
  /** Structured runner options used to reconstruct an interactive resume command. */
  resumeOptions: 'agent:resume-options',
  updatedAt: 'agent:updated-at',
  attempts: 'agent:attempts',
  error: 'agent:error',
  reply: 'agent:reply',
  /** Transient "what the run is doing now" label (on a queued task, why it
   *  waits); empty/absent when idle. */
  activity: 'agent:activity',
  /** Timestamp when the current activity began, ms since epoch. */
  activityAt: 'agent:activity-at',
  /** Written by the Ask Agent action (companion-owned, daemon-inert). */
  askedAt: 'agent:asked-at',
  /** Written by the Stop Agent action; the daemon clears it once the
   *  running task is aborted and parked as `error: cancelled`. */
  cancel: 'agent:cancel',
  /** Set by Retry and consumed by the mention watcher when it accepts the run. */
  retryAt: 'agent:retry-at',
} as const

export type ChipKind = 'queued' | 'running' | 'done' | 'error'

export interface ChipState {
  kind: ChipKind
  executor: string
  executorLabel: string
  /** Status-transition timestamp (claim/done/error), ms — null if absent. */
  updatedAtMs: number | null
  attempts: number
  /** Error message for kind 'error' (may be empty). */
  errorMessage: string
  /** "What the run is doing now" — empty when absent/non-string. */
  activity: string
  /** Start of the current activity, ms — null if absent or invalid. */
  activityAtMs: number | null
  /** True while a running task has a pending `agent:cancel` the daemon
   *  hasn't acted on yet. */
  cancelling: boolean
}

type Properties = Record<string, unknown> | undefined

const labelForExecutor = (executor: string): string => {
  if (executor === 'codex') return 'Codex'
  if (executor === 'claude') return 'Claude'
  return executor
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => part[0] ? `${part[0].toUpperCase()}${part.slice(1)}` : part)
    .join(' ') || 'Agent'
}

export const chipStateFor = (properties: Properties): ChipState | null => {
  const status = properties?.[AGENT_PROPS.status]
  if (status !== 'queued' && status !== 'running' && status !== 'done' && status !== 'error') {
    return null
  }
  const executorValue = properties?.[AGENT_PROPS.executor]
  const executor = typeof executorValue === 'string' && executorValue.length > 0 ? executorValue : 'claude'
  const updatedAt = properties?.[AGENT_PROPS.updatedAt]
  const attempts = properties?.[AGENT_PROPS.attempts]
  const error = properties?.[AGENT_PROPS.error]
  const activity = properties?.[AGENT_PROPS.activity]
  const activityAt = properties?.[AGENT_PROPS.activityAt]
  const cancel = properties?.[AGENT_PROPS.cancel]
  return {
    kind: status,
    executor,
    executorLabel: labelForExecutor(executor),
    updatedAtMs: typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : null,
    attempts: typeof attempts === 'number' && attempts > 0 ? Math.floor(attempts) : 1,
    errorMessage: typeof error === 'string' ? error : '',
    activity: typeof activity === 'string' ? activity : '',
    activityAtMs: typeof activityAt === 'number' && activityAt > 0 && activityAt < Infinity ? activityAt : null,
    cancelling: status === 'running' && Boolean(cancel),
  }
}

/** At most three characters for any realistic run, so the fixed-width pill
 *  never truncates it. */
export const elapsedLabel = (seconds: number): string => {
  if (seconds < 100) return `${Math.round(seconds)}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 100) return `${minutes}m`
  return `${Math.round(seconds / 3_600)}h`
}

export interface ActivityState {
  ageLabel: string
  stalled: boolean
}

const KM_TOOL_ACTIVITY_LABELS = {
  get_block: 'Reading',
  subtree: 'Reading',
  backlinks: 'Reading',
  grouped_backlinks: 'Reading',
  page: 'Reading',
  daily_note: 'Reading',
  search: 'Search',
  guide: 'Reading',
  sql_query: 'Reading',
  read_media: 'Reading',
  create_block: 'Writing',
  update_block: 'Writing',
  move_block: 'Writing',
  delete_block: 'Writing',
  restore_block: 'Writing',
  append_markdown: 'Writing',
  edit_block: 'Writing',
  create_page: 'Writing',
  add_media: 'Writing',
  list_contributors: 'Reading',
  create_contributor: 'Writing',
  recent_changes: 'Reading',
  block_history: 'Reading',
  comments: 'Reading',
  add_comment: 'Writing',
} satisfies Record<KmMcpToolName, string>

/** Short labels for the fixed-width status pill. Unknown km tools stay neutral. */
export const compactActivityLabel = (activity: string): string => {
  if (activity === 'Thinking') return 'Thinking'
  if (activity === 'Searching the web') return 'Search'
  if (activity === 'Fetching a page') return 'Fetching'
  if (activity === 'Running a command' || activity === 'Bash') return 'Running'
  if (activity === 'Read') return 'Reading'
  if (activity === 'Edit' || activity === 'Write') return 'Writing'
  const kmTool = /^km:\s*([a-z_]+)$/.exec(activity)?.[1] as KmMcpToolName | undefined
  if (kmTool && Object.hasOwn(KM_TOOL_ACTIVITY_LABELS, kmTool)) return KM_TOOL_ACTIVITY_LABELS[kmTool]
  return 'Working'
}

const KM_ACTIVITY_PREFIX = 'km:'
const KM_STALLED_THRESHOLD_MS = BRIDGE_COMMAND_TIMEOUT_MS / 3

/** Current step age and warning for timestamped running work. */
export const activityStateFor = (chip: ChipState, nowMs: number): ActivityState | null => {
  if (chip.kind !== 'running' || chip.cancelling || !chip.activity || chip.activityAtMs === null) return null
  // Device clock skew can make activity age approximate; future timestamps are clamped below.
  const ageMs = Math.max(0, nowMs - chip.activityAtMs)
  const stalled = chip.activity.startsWith(KM_ACTIVITY_PREFIX) && ageMs > KM_STALLED_THRESHOLD_MS
  return {
    ageLabel: elapsedLabel(Math.ceil(ageMs / 1_000)),
    stalled,
  }
}

/** Detail text shared by the tooltip and action menu so both clocks agree. */
export const chipActivityDetails = (chip: ChipState, activity: ActivityState | null, nowMs: number): string => {
  const label = compactActivityLabel(chip.activity)
  const details = [chip.activity && chip.activity !== label ? `${label}: ${chip.activity}` : label]
  if (activity) details.push(`${activity.ageLabel} on this step`)
  if (chip.updatedAtMs !== null) {
    details.push(`${elapsedLabel(Math.max(0, Math.round((nowMs - chip.updatedAtMs) / 1_000)))} total`)
  }
  return details.join(' · ')
}

export const chipTitle = (chip: ChipState, activity: ActivityState | null, nowMs: number): string => {
  switch (chip.kind) {
    case 'queued':
      return chip.activity ? `Queued for ${chip.executorLabel} — ${chip.activity}` : `Queued for ${chip.executorLabel}`
    case 'running': {
      if (chip.cancelling) return `Cancelling the ${chip.executorLabel} run`
      const base = chip.attempts > 1
        ? `${chip.executorLabel} is working (attempt ${chip.attempts})`
        : `${chip.executorLabel} is working`
      if (!chip.activity && chip.updatedAtMs === null) return base
      const detail = chipActivityDetails(chip, activity, nowMs)
      const title = `${base} — ${detail}`
      if (!activity?.stalled) return title
      return `${title} · No progress for ${activity.ageLabel}; the app tab may not be answering`
    }
    case 'done':
      return chip.updatedAtMs
        ? `${chip.executorLabel} replied · ${new Date(chip.updatedAtMs).toLocaleString()}`
        : `${chip.executorLabel} replied`
    case 'error':
      return chip.errorMessage
        ? `${chip.executorLabel} run failed: ${chip.errorMessage}`
        : `${chip.executorLabel} run failed`
  }
}
