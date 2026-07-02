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
}

/**
 * Should this backlink source become a task?
 * - never trigger on daemon-authored replies (`claude:reply`). Mentions
 *   NESTED under a reply are user-authored follow-ups and DO fire — loop
 *   safety comes from replies themselves being marked plus the MCP write
 *   tools refusing watcher-target links/ids, not from a blanket subtree ban;
 * - skip anything already claimed, except a stale `running` (crashed or
 *   dropped run) which re-queues until MAX_ATTEMPTS, then parks;
 * - wait out the quiet period so half-typed requests aren't claimed.
 */
export const decidePending = ({source, nowMs, quietMs = 0}: PendingArgs): PendingDecision => {
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

  if (quietMs > 0 && typeof source.editedAtMs === 'number' && nowMs - source.editedAtMs < quietMs) {
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

/** Rows must carry a stable `id`; anything else is passed to the prompt. */
export interface QueryRow {
  id: string
  [key: string]: unknown
}

const rowId = (row: unknown): string | null => {
  if (!row || typeof row !== 'object') return null
  const id = (row as {id?: unknown}).id
  return typeof id === 'string' && id ? id : null
}

export interface QueryDiff {
  newRows: QueryRow[]
  /** Union of everything ever seen (bounded) — the next cursor. */
  seenIds: string[]
  /** Rows without a usable id (skipped, surfaced for logging). */
  invalidRows: number
}

/** Cursor retention bound. Oldest ids are forgotten past this, which
 *  can re-fire an ancient row that re-enters the result set — the
 *  cheap failure direction (one extra run) vs unbounded growth. */
export const MAX_CURSOR_IDS = 20_000

/**
 * Diff current query results against the previously-seen id UNION.
 * First run (`prevIds === null`) establishes the baseline WITHOUT
 * firing — a fresh watcher shouldn't replay the whole backlog.
 *
 * The cursor is a union, not the current id set: with a LIMIT'd or
 * ordered query, rows rotate out and back in as other rows churn —
 * a current-set cursor would re-fire (and re-bill) on every rotation.
 */
export const diffQueryRows = (rows: unknown[], prevIds: string[] | null): QueryDiff => {
  const valid: QueryRow[] = []
  let invalidRows = 0
  for (const row of rows) {
    const id = rowId(row)
    if (id) valid.push(row as QueryRow)
    else invalidRows += 1
  }

  if (prevIds === null) {
    return {newRows: [], seenIds: valid.map(row => row.id).slice(-MAX_CURSOR_IDS), invalidRows}
  }

  const prev = new Set(prevIds)
  const newRows = valid.filter(row => !prev.has(row.id))
  const seenIds = [...prevIds, ...newRows.map(row => row.id)].slice(-MAX_CURSOR_IDS)
  return {newRows, seenIds, invalidRows}
}
