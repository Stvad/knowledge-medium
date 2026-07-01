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
}

export interface PendingDecision {
  pending: boolean
  reason:
    | 'pending'
    | 'already-processed'
    | 'is-reply'
    | 'inside-reply'
    | 'stale-running'
}

const prop = (block: BlockView | undefined, key: string): unknown =>
  block?.properties?.[key]

export const taskStatus = (block: BlockView | undefined): TaskStatus | null => {
  const value = prop(block, PROPS.status)
  return value === 'queued' || value === 'running' || value === 'done' || value === 'error'
    ? value
    : null
}

/** `running` entries older than this are treated as crashed-mid-run and
 *  re-queued on the next sweep. The daemon is the only writer of these
 *  properties, so a long-stale `running` can only mean a dead run. */
export const STALE_RUNNING_MS = 30 * 60_000

export interface PendingArgs {
  source: BlockView
  /** Ancestor chain, nearest first (parent, grandparent, …). */
  ancestors: BlockView[]
  nowMs: number
}

/**
 * Should this backlink source become a task?
 * - skip anything the daemon already claimed (any status), except a
 *   stale `running` left behind by a crash — that re-queues;
 * - never trigger on daemon-authored replies, or anywhere inside one
 *   (otherwise a reply that mentions the target page loops forever).
 */
export const decidePending = ({source, ancestors, nowMs}: PendingArgs): PendingDecision => {
  if (prop(source, PROPS.reply)) return {pending: false, reason: 'is-reply'}
  if (ancestors.some(ancestor => prop(ancestor, PROPS.reply))) {
    return {pending: false, reason: 'inside-reply'}
  }

  const status = taskStatus(source)
  if (status === 'running') {
    const updatedAt = prop(source, PROPS.updatedAt)
    const age = typeof updatedAt === 'number' ? nowMs - updatedAt : Number.POSITIVE_INFINITY
    if (age >= STALE_RUNNING_MS) return {pending: true, reason: 'stale-running'}
    return {pending: false, reason: 'already-processed'}
  }
  if (status) return {pending: false, reason: 'already-processed'}

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

export const rowId = (row: unknown): string | null => {
  if (!row || typeof row !== 'object') return null
  const id = (row as {id?: unknown}).id
  return typeof id === 'string' && id ? id : null
}

export interface QueryDiff {
  newRows: QueryRow[]
  /** Full current id set — becomes the next cursor. */
  seenIds: string[]
  /** Rows without a usable id (skipped, surfaced for logging). */
  invalidRows: number
}

/**
 * Diff current query results against the previously-seen id set.
 * First run (`prevIds === null`) establishes the baseline WITHOUT
 * firing — a fresh watcher shouldn't replay the whole backlog.
 */
export const diffQueryRows = (rows: unknown[], prevIds: string[] | null): QueryDiff => {
  const valid: QueryRow[] = []
  let invalidRows = 0
  for (const row of rows) {
    const id = rowId(row)
    if (id) valid.push(row as QueryRow)
    else invalidRows += 1
  }

  const seenIds = valid.map(row => row.id)
  if (prevIds === null) return {newRows: [], seenIds, invalidRows}

  const prev = new Set(prevIds)
  return {
    newRows: valid.filter(row => !prev.has(row.id)),
    seenIds,
    invalidRows,
  }
}
