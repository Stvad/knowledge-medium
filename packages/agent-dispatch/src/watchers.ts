/**
 * Watcher decision logic — pure functions deciding WHICH graph events
 * become tasks. The graph itself is the source of truth for backlink
 * watchers (a source block without our status property is pending), so
 * a daemon restart re-derives the queue instead of trusting a cache.
 */
import { PROPS, type TaskStatus } from './config.js'

/** The slice of a block the pending-decision needs. */
export interface BlockView {
  id: string
  content?: string
  properties?: Record<string, unknown>
  parentId?: string | null
  /** Last user edit (ms) — gates the quiet period before claiming. */
  editedAtMs?: number | null
}

export interface PendingDecision {
  pending: boolean
  reason:
    | 'pending'
    | 'already-processed'
    | 'is-reply'
    | 'still-typing'
    | 'stale-running'
    | 'attempts-exhausted'
    | 'pre-baseline'
}

const prop = (block: BlockView | undefined, key: string): unknown =>
  block?.properties?.[key]

const taskStatus = (block: BlockView | undefined): TaskStatus | null => {
  const value = prop(block, PROPS.status)
  return value === 'queued' || value === 'running' || value === 'done' || value === 'error'
    ? value
    : null
}

export const taskAttempts = (block: BlockView | undefined): number => {
  const value = prop(block, PROPS.attempts)
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** `running` entries older than this are treated as crashed-mid-run and
 *  re-queued on the next sweep. The daemon is the only writer of these
 *  properties, so a long-stale `running` can only mean a dead run (run
 *  timeoutMs is capped below this in config.ts). */
export const STALE_RUNNING_MS = 30 * 60_000

/** A task is re-claimed at most this many times before it's parked as
 *  `error` — caps the requeue loop (and its bill) when something keeps
 *  crashing or the ambient channel session keeps dropping the event. */
export const MAX_ATTEMPTS = 3

export interface PendingArgs {
  source: BlockView
  nowMs: number
  /** Minimum quiet time since the last user edit before claiming. */
  quietMs?: number
  /** Watcher's first-tick timestamp: unclaimed blocks last edited before
   *  it are pre-existing content, never tasks. null/undefined = no gate. */
  baselineMs?: number | null
  /** The quiet period was already confirmed at the SOURCE (the tab saw
   *  the user leave the block, or its settle window elapsed) — skip the
   *  clock-based still-typing gate. Baseline/status gates still apply. */
  quietExempt?: boolean
}

/**
 * Should this backlink source become a task?
 * - never trigger on daemon-authored replies (`agent:reply`). Mentions
 *   NESTED under a reply are user-authored follow-ups and DO fire — loop
 *   safety comes from replies themselves being marked plus the MCP write
 *   tools refusing watcher-target links/ids, not from a blanket subtree ban;
 * - skip anything already claimed, except a stale `running` (crashed or
 *   dropped run) which re-queues until MAX_ATTEMPTS, then parks;
 * - skip unclaimed blocks that predate the watcher baseline — pointing a
 *   watcher at an established page must not claim (and bill) its history;
 * - wait out the quiet period so half-typed requests aren't claimed.
 */
export const decidePending = ({source, nowMs, quietMs = 0, baselineMs, quietExempt = false}: PendingArgs): PendingDecision => {
  if (prop(source, PROPS.reply)) return {pending: false, reason: 'is-reply'}

  const status = taskStatus(source)
  if (status === 'running') {
    const updatedAt = prop(source, PROPS.updatedAt)
    const age = typeof updatedAt === 'number' ? nowMs - updatedAt : Number.POSITIVE_INFINITY
    if (age < STALE_RUNNING_MS) return {pending: false, reason: 'already-processed'}
    if (taskAttempts(source) >= MAX_ATTEMPTS) return {pending: false, reason: 'attempts-exhausted'}
    return {pending: true, reason: 'stale-running'}
  }
  if (status) return {pending: false, reason: 'already-processed'}

  // Baseline gate only for UNCLAIMED blocks (a claim implies the block
  // already passed it). Unknown edit time counts as old: every real row
  // carries updated_at, and firing on "can't tell" is the direction
  // that claims — and bills — a page's entire history.
  if (typeof baselineMs === 'number'
    && !(typeof source.editedAtMs === 'number' && source.editedAtMs >= baselineMs)) {
    return {pending: false, reason: 'pre-baseline'}
  }

  if (!quietExempt && quietMs > 0 && typeof source.editedAtMs === 'number' && nowMs - source.editedAtMs < quietMs) {
    return {pending: false, reason: 'still-typing'}
  }

  return {pending: true, reason: 'pending'}
}

/** Nearest ancestor session id (the "thread" a follow-up mention joins). */
export const findThreadSession = (source: BlockView, ancestors: BlockView[]): string | null => {
  for (const block of [source, ...ancestors]) {
    const session = prop(block, PROPS.session)
    if (typeof session === 'string' && session) return session
  }
  return null
}

// ----- query watchers -------------------------------------------------

// The query-row diff (`diffQueryRows`/`MAX_CURSOR_IDS` + its `QueryRow`/
// `QueryDiff` shapes) lives in the dependency-light `queryDiff.ts` so its
// fuzz suite can import the pure logic without dragging in this module's
// `./config.js` → `@knowledge-medium/agent-cli/*` chain (untracked dist,
// unresolvable on a pre-build CI runner — see queryDiff.ts). Re-exported
// here so the daemon's existing call sites keep their import surface.
export { diffQueryRows, MAX_CURSOR_IDS } from './queryDiff.js'
export type { QueryRow, QueryDiff } from './queryDiff.js'
