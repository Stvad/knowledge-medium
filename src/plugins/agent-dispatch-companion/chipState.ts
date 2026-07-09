/**
 * Pure decision logic for the Agent status chip: block properties →
 * chip descriptor. The property protocol is owned by the agent-dispatch
 * daemon (packages/agent-dispatch/src/config.ts PROPS) — names are
 * duplicated here because the app bundle can't depend on that node
 * package; keep the two in sync.
 */

export const AGENT_PROPS = {
  status: 'agent:status',
  executor: 'agent:executor',
  watcher: 'agent:watcher',
  /** Executor session/thread id. Codex threads are stored as `codex:<id>`. */
  session: 'agent:session',
  updatedAt: 'agent:updated-at',
  attempts: 'agent:attempts',
  error: 'agent:error',
  reply: 'agent:reply',
  /** Transient "what the run is doing now" label; empty/absent when idle. */
  activity: 'agent:activity',
  /** Written by the Ask Agent action (companion-owned, daemon-inert). */
  askedAt: 'agent:asked-at',
  /** Written by the Stop Agent action; the daemon clears it once the
   *  running task is aborted and parked as `error: cancelled`. */
  cancel: 'agent:cancel',
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
  const cancel = properties?.[AGENT_PROPS.cancel]
  return {
    kind: status,
    executor,
    executorLabel: labelForExecutor(executor),
    updatedAtMs: typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : null,
    attempts: typeof attempts === 'number' && attempts > 0 ? Math.floor(attempts) : 1,
    errorMessage: typeof error === 'string' ? error : '',
    activity: typeof activity === 'string' ? activity : '',
    cancelling: status === 'running' && Boolean(cancel),
  }
}

export const chipTitle = (chip: ChipState): string => {
  switch (chip.kind) {
    case 'queued':
      return `Queued for ${chip.executorLabel}`
    case 'running': {
      const base = chip.attempts > 1
        ? `${chip.executorLabel} is working (attempt ${chip.attempts})`
        : `${chip.executorLabel} is working`
      return chip.activity ? `${base} — ${chip.activity}` : base
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
