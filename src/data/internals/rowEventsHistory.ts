/** `stateAt` — the row_events v2 reconstruction reader
 *  (docs/row-events-optimization.html §4.3).
 *
 *  Reconstructs a block's row state (domain-shaped, exactly what
 *  `blockJsonObjectSql` serializes) just after any event. Full events
 *  (v1 rows, creates, hard deletes, sampled anchors) answer directly from
 *  their own payload; compact v2 events walk to the nearest full state on
 *  EITHER side:
 *
 *  - older side: newest event ≤ E with a full AFTER (create, anchor,
 *    v1 update) → walk FORWARD applying after_json patches.
 *  - newer side: oldest event > E with a full BEFORE (anchor, delete,
 *    v1 update), or the live `blocks` row itself → walk BACKWARD
 *    un-applying before_json patches.
 *
 *  The newer side always terminates in a well-formed log (invariant I2): a
 *  live block ends at its `blocks` row, a purged block at its delete event.
 *  A missing newer side can only mean corruption inside the log — with one
 *  raw-write asterisk: a raw `UPDATE … SET id` orphans the old id's chain
 *  (design §3), which then recovers via its older-side fulls only.
 *
 *  Unlogged gaps (history_mode skips, trigger-suspended backfills, the
 *  pre-log era) degrade only states OLDER than the gap, back to the
 *  next-older full state — the backward walk from the live row is exact for
 *  everything at or newer than the last gap (design §4.3/§5.2). */

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

const parseSide = (json: string | null, eventId: number, side: string): BlockHistoryState => {
  if (json === null) {
    throw new HistoryWalkError(`event ${eventId} has no ${side} payload`, eventId)
  }
  return JSON.parse(json) as BlockHistoryState
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

/** Row state just after event `eventId` (design §4.3). */
export const stateAt = async (
  db: RowEventsHistoryDb,
  eventId: number,
): Promise<BlockHistoryState> => {
  const event = await getEvent(db, eventId)
  if (isFull(event)) return fullEventState(event)

  // Compact event: locate the nearest full state on each side. Older base =
  // newest full-AFTER at or before E; newer terminator = oldest full-BEFORE
  // strictly after E (always nearer than the live row when it exists).
  const [olderBase] = await db.getAll<RowEventRecord>(
    `SELECT ${EVENT_COLUMNS_SQL} FROM row_events
     WHERE block_id = ? AND id <= ? AND (v IS NULL OR full = 1) AND after_json IS NOT NULL
     ORDER BY id DESC LIMIT 1`,
    [event.block_id, event.id],
  )
  const [newerTerminator] = await db.getAll<RowEventRecord>(
    `SELECT ${EVENT_COLUMNS_SQL} FROM row_events
     WHERE block_id = ? AND id > ? AND (v IS NULL OR full = 1) AND before_json IS NOT NULL
     ORDER BY id ASC LIMIT 1`,
    [event.block_id, event.id],
  )
  const liveRows = newerTerminator
    ? []
    : await db.getAll<{state_json: string}>(LIVE_ROW_STATE_SQL, [event.block_id])
  const liveRowState = liveRows.length > 0
    ? (JSON.parse(liveRows[0].state_json) as BlockHistoryState)
    : null

  // Walk lengths (patch steps) on each side, to pick the nearer. COUNT
  // first so only the chosen range is actually loaded.
  const count = async (fromExclusive: number, toInclusive: number | null): Promise<number> => {
    const rows = await db.getAll<{n: number}>(
      toInclusive === null
        ? 'SELECT COUNT(*) AS n FROM row_events WHERE block_id = ? AND id > ?'
        : 'SELECT COUNT(*) AS n FROM row_events WHERE block_id = ? AND id > ? AND id <= ?',
      toInclusive === null ? [event.block_id, fromExclusive] : [event.block_id, fromExclusive, toInclusive],
    )
    return rows[0]?.n ?? 0
  }
  const forwardSteps = olderBase ? await count(olderBase.id, event.id) : null
  const backwardSteps = newerTerminator
    ? await count(event.id, newerTerminator.id) - 1 // events strictly between E and N
    : liveRowState !== null
      ? await count(event.id, null)
      : null

  if (forwardSteps === null && backwardSteps === null) {
    throw new HistoryWalkError(
      `no full state reachable from event ${event.id} on either side — ` +
      'log corruption, or the orphaned old-id chain of a raw id rewrite',
      event.id,
    )
  }
  const walkForward = forwardSteps !== null && (backwardSteps === null || forwardSteps <= backwardSteps)

  if (walkForward) {
    // olderBase is non-null here by the walkForward predicate.
    const base = olderBase
    const range = await db.getAll<RowEventRecord>(
      `SELECT ${EVENT_COLUMNS_SQL} FROM row_events
       WHERE block_id = ? AND id > ? AND id <= ? ORDER BY id ASC`,
      [event.block_id, base.id, event.id],
    )
    let state = parseSide(base.after_json, base.id, 'after')
    for (const step of range) {
      if (isFull(step)) {
        // Can't appear in a well-formed compact run (base was the NEWEST
        // full-after ≤ E; a delete here would imply post-delete events with
        // no create). Signal instead of silently splicing.
        throw new HistoryWalkError(
          `unexpected full event ${step.id} inside compact run before event ${event.id}`,
          event.id,
        )
      }
      state = applyPatch(state, parseSide(step.after_json, step.id, 'after'))
    }
    return state
  }

  // Backward: start from the state just before the terminator (its full
  // before side), or from the live row; un-apply each compact event's
  // before-patch, newest first, down to (but excluding) E.
  const range = await db.getAll<RowEventRecord>(
    newerTerminator
      ? `SELECT ${EVENT_COLUMNS_SQL} FROM row_events
         WHERE block_id = ? AND id > ? AND id < ? ORDER BY id DESC`
      : `SELECT ${EVENT_COLUMNS_SQL} FROM row_events
         WHERE block_id = ? AND id > ? ORDER BY id DESC`,
    newerTerminator ? [event.block_id, event.id, newerTerminator.id] : [event.block_id, event.id],
  )
  let state = newerTerminator
    ? parseSide(newerTerminator.before_json, newerTerminator.id, 'before')
    : (liveRowState as BlockHistoryState)
  for (const step of range) {
    if (isFull(step)) {
      throw new HistoryWalkError(
        `unexpected full event ${step.id} inside compact run after event ${event.id}`,
        event.id,
      )
    }
    state = applyPatch(state, parseSide(step.before_json, step.id, 'before'))
  }
  return state
}
