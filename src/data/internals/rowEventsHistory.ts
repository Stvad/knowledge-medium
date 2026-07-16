/** `stateAt` — the row_events v2 reconstruction reader
 *  (docs/row-events-optimization.html §4.3).
 *
 *  Reconstructs a block's row state (domain-shaped, exactly what
 *  `blockJsonObjectSql` serializes) just after any event. Full events
 *  (v1 rows, creates, hard deletes, sampled anchors) answer directly from
 *  their own payload; compact v2 events walk to a full state on either side:
 *
 *  - newer side (PREFERRED): oldest event > E with a full BEFORE (anchor,
 *    delete, v1 update), or the live `blocks` row itself → walk BACKWARD
 *    un-applying before_json patches. Preferred because it is exact for
 *    every state at or newer than the last unlogged gap (history_mode
 *    skips, trigger-suspended backfills, the pre-log era — design
 *    §4.3/§5.2): un-applying an event's own trigger-recorded old values
 *    cannot be poisoned by writes the log never saw. Anchors carry full
 *    befores, so this walk is bounded by anchor spacing like any other.
 *  - older side (FALLBACK): newest event ≤ E with a full AFTER (create,
 *    anchor, v1 update) → walk FORWARD applying after_json patches. Used
 *    when the newer side doesn't exist or is severed — a full event inside
 *    a backward run is a newer-generation `create` (the block was purged
 *    and recreated with the gap unlogged), which proves the live side
 *    cannot reach E; the forward walk from E's own generation still can.
 *
 *  The newer side always exists in a well-formed log (invariant I2): a live
 *  block ends at its `blocks` row, a purged block at its delete event. Both
 *  sides unreachable means corruption — with one raw-write asterisk: a raw
 *  `UPDATE … SET id` orphans the old id's chain (design §3), which then
 *  recovers via its older-side fulls only. The walk never guesses: it
 *  throws {@link HistoryWalkError} instead.
 *
 *  Concurrency: the reads run as separate statements with no snapshot
 *  isolation (the client DB has a single serialized SQLite worker, but
 *  statements from other tasks can interleave between them). The failure
 *  modes are benign: events appended after the live-row fetch un-apply as
 *  fixpoint no-ops (their before values equal the fetched state), and an
 *  interleaved anchor/delete at worst severs the backward run, falling back
 *  to the (gap-free, therefore exact) forward walk. */

import {blockJsonObjectSql} from './clientSchema'

export interface RowEventsHistoryDb {
  getAll: <T>(sql: string, params?: unknown[]) => Promise<T[]>
}

export interface RowEventRecord {
  id: number
  block_id: string
  kind: string
  before_json: string | null
  after_json: string | null
  v: number | null
  full: number | null
}

/** Domain-shaped row state — the parsed form of a full snapshot payload
 *  (13 fixed keys, see `ROW_EVENT_COLUMNS` in clientSchema.ts). */
export type BlockHistoryState = Record<string, unknown>

/** The log cannot answer: a compact event has no reachable full state on
 *  either side. In a well-formed log this is corruption (or the raw
 *  id-rewrite asterisk); the walk never guesses. */
export class HistoryWalkError extends Error {
  constructor(message: string, readonly eventId: number) {
    super(message)
    this.name = 'HistoryWalkError'
  }
}

const EVENT_COLUMNS_SQL = 'id, block_id, kind, before_json, after_json, v, full'

/** v1 rows (`v IS NULL`) are full by construction; v2 rows say so. */
const isFull = (e: RowEventRecord): boolean => e.v === null || e.full === 1

/** Parse a payload side, converting missing/corrupt JSON into the typed
 *  corruption signal rather than a raw SyntaxError. */
const parseSide = (json: string | null, eventId: number, side: string): BlockHistoryState => {
  if (json === null) {
    throw new HistoryWalkError(`event ${eventId} has no ${side} payload`, eventId)
  }
  try {
    return JSON.parse(json) as BlockHistoryState
  } catch {
    throw new HistoryWalkError(`event ${eventId} has a corrupt ${side} payload`, eventId)
  }
}

/** State just after a full event, from its own payload: create/anchor/v1
 *  update → after side; hard delete → before side (the tombstone content —
 *  the row itself no longer exists after it). */
const fullEventState = (e: RowEventRecord): BlockHistoryState =>
  e.kind === 'delete'
    ? parseSide(e.before_json, e.id, 'before')
    : parseSide(e.after_json, e.id, 'after')

const getEvent = async (db: RowEventsHistoryDb, eventId: number): Promise<RowEventRecord> => {
  const rows = await db.getAll<RowEventRecord>(
    `SELECT ${EVENT_COLUMNS_SQL} FROM row_events WHERE id = ?`,
    [eventId],
  )
  if (rows.length === 0) throw new HistoryWalkError(`no row_events row with id ${eventId}`, eventId)
  return rows[0]
}

/** Merge a compact patch into a state: key present ⇔ field changed, values
 *  land verbatim (JSON null = cleared). Applying an after-patch moves the
 *  state forward across the event; merging a before-patch un-applies it
 *  (equal key sets make both directions single-object merges — invariant
 *  I1). */
const applyPatch = (state: BlockHistoryState, patch: BlockHistoryState): BlockHistoryState => ({
  ...state,
  ...patch,
})

/** The live `blocks` row in the exact domain shape the payloads use — the
 *  backward walk's default starting point (and the reason recent history is
 *  exact even across unlogged gaps). */
const LIVE_ROW_STATE_SQL = `
  SELECT ${blockJsonObjectSql('blocks')} AS state_json FROM blocks WHERE id = ?
`

/** Backward walk: start from the state just before the terminator (its full
 *  before side) or from the live row, and un-apply each compact event's
 *  before-patch, newest first, down to (but excluding) E. Returns null when
 *  this side is unavailable, or severed by a full event inside the run —
 *  the only full event that can appear there is a newer-generation `create`
 *  (any full-BEFORE event would have been picked as the terminator), which
 *  proves E's generation is unreachable from the live side. */
const walkBackward = async (
  db: RowEventsHistoryDb,
  event: RowEventRecord,
): Promise<BlockHistoryState | null> => {
  const [terminator] = await db.getAll<RowEventRecord>(
    `SELECT ${EVENT_COLUMNS_SQL} FROM row_events
     WHERE block_id = ? AND id > ? AND (v IS NULL OR full = 1) AND before_json IS NOT NULL
     ORDER BY id ASC LIMIT 1`,
    [event.block_id, event.id],
  )
  let state: BlockHistoryState
  if (terminator) {
    state = parseSide(terminator.before_json, terminator.id, 'before')
  } else {
    const liveRows = await db.getAll<{state_json: string}>(LIVE_ROW_STATE_SQL, [event.block_id])
    if (liveRows.length === 0) return null
    try {
      state = JSON.parse(liveRows[0].state_json) as BlockHistoryState
    } catch {
      throw new HistoryWalkError(`live row for block ${event.block_id} has corrupt JSON cells`, event.id)
    }
  }
  const range = await db.getAll<RowEventRecord>(
    terminator
      ? `SELECT ${EVENT_COLUMNS_SQL} FROM row_events
         WHERE block_id = ? AND id > ? AND id < ? ORDER BY id DESC`
      : `SELECT ${EVENT_COLUMNS_SQL} FROM row_events
         WHERE block_id = ? AND id > ? ORDER BY id DESC`,
    terminator ? [event.block_id, event.id, terminator.id] : [event.block_id, event.id],
  )
  for (const step of range) {
    if (isFull(step)) return null // newer-generation create — this side can't reach E
    state = applyPatch(state, parseSide(step.before_json, step.id, 'before'))
  }
  return state
}

/** Forward walk: start from the older base's full after side and apply each
 *  compact event's after-patch up to and including E. Returns null when no
 *  base exists, or the run is severed by a full event — the only full event
 *  that can appear there is a hard `delete` (any full-AFTER event would
 *  have been picked as the base), which proves E belongs to a later
 *  generation whose beginning the log never saw. */
const walkForward = async (
  db: RowEventsHistoryDb,
  event: RowEventRecord,
): Promise<BlockHistoryState | null> => {
  const [base] = await db.getAll<RowEventRecord>(
    `SELECT ${EVENT_COLUMNS_SQL} FROM row_events
     WHERE block_id = ? AND id <= ? AND (v IS NULL OR full = 1) AND after_json IS NOT NULL
     ORDER BY id DESC LIMIT 1`,
    [event.block_id, event.id],
  )
  if (!base) return null
  const range = await db.getAll<RowEventRecord>(
    `SELECT ${EVENT_COLUMNS_SQL} FROM row_events
     WHERE block_id = ? AND id > ? AND id <= ? ORDER BY id ASC`,
    [event.block_id, base.id, event.id],
  )
  let state = parseSide(base.after_json, base.id, 'after')
  for (const step of range) {
    if (isFull(step)) return null // hard delete mid-run — E is past an unlogged recreate
    state = applyPatch(state, parseSide(step.after_json, step.id, 'after'))
  }
  return state
}

/** Row state just after event `eventId` (design §4.3). Backward-first —
 *  see the module header for why the newer side is the exact one. */
export const stateAt = async (
  db: RowEventsHistoryDb,
  eventId: number,
): Promise<BlockHistoryState> => {
  const event = await getEvent(db, eventId)
  if (isFull(event)) return fullEventState(event)

  const backward = await walkBackward(db, event)
  if (backward !== null) return backward
  const forward = await walkForward(db, event)
  if (forward !== null) return forward

  throw new HistoryWalkError(
    `no full state reachable from event ${event.id} on either side — ` +
    'log corruption, or the orphaned old-id chain of a raw id rewrite',
    event.id,
  )
}
