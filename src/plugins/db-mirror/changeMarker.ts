/*
 * The cheap "is a fresh copy worth taking?" reading.
 *
 * TWO parts, because two different things can make the copy on disk stale.
 *
 * `row_events.id` is an AUTOINCREMENT the client schema's triggers advance on
 * every insert, update and delete of `blocks` — local `repo.tx` writes and
 * sync-applied ones alike — so its maximum moves exactly when the DATA worth
 * copying moves, and reading it is a rowid lookup rather than a scan. That
 * matters because the alternative is copying multiple gigabytes to discover
 * nothing changed.
 *
 * The other two are the upload queues, and they are in here for a
 * restore-safety reason rather than a data one. THE RULE, so the next reader
 * knows where the line is: the marker tracks the data, plus every local table
 * whose stale contents can cause a WRITE TO THE SERVER when the copy is
 * restored. It deliberately does not track local tables whose staleness is
 * merely cosmetic — undo history, recents, the event log — because being
 * as-of-that-moment is what restoring a snapshot MEANS, and fingerprinting the
 * whole database would leave nothing for the skip to skip.
 *
 * `ps_crud` is the pending-upload queue: restoring a stale one replays its
 * patches, which are column-LWW and so overwrite values another device has
 * since changed. `ps_crud_rejected` qualifies under the same rule because the
 * rejection dialog's Retry button puts a row straight back into `ps_crud`.
 *
 * Rejected alternative for the first part: PowerSync's `ps_sync_state`
 * checkpoint. It advances on SYNC, so a device working offline all day would
 * mirror nothing — precisely the unsynced local work this feature protects.
 */
/** Which database this is, or which of the two ways of not knowing applies. */
export type DatabaseIncarnation =
  | {kind: 'known'; id: string}
  /** No local writes yet, so nothing this feature protects exists. */
  | {kind: 'empty'}
  /** The log could not be read; the database itself may be perfectly copyable. */
  | {kind: 'unreadable'}

/** Just enough of `Repo` to read these — and `Repo` satisfies it structurally,
 *  so callers pass one directly and no cast is involved. */
export interface ChangeMarkerSource {
  db: {getAll: <T>(sql: string) => Promise<T[]>}
}

/** Stands in for the queue reading when `ps_crud` cannot be read. CONSTANT on
 *  purpose: an unreadable queue must not look like a changing one, or every run
 *  would copy. It degrades to the pre-queue behaviour, which is the honest
 *  answer when the queue is unknowable. */
const QUEUE_UNKNOWN = '?'

const readQueueFingerprint = async (
  repo: ChangeMarkerSource,
  table: 'ps_crud' | 'ps_crud_rejected',
): Promise<string> => {
  try {
    const [row] = await repo.db.getAll<{n: number; last: number | null}>(
      `SELECT COUNT(*) AS n, MAX(id) AS last FROM ${table}`,
    )
    // Both, because either alone is blind to a case: the count misses a queue
    // that gained and drained an entry between runs, and the id misses a drain.
    return `${row?.n ?? 0}.${row?.last ?? 0}`
  } catch (err) {
    console.warn(`[db-mirror] could not read ${table}`, err)
    return QUEUE_UNKNOWN
  }
}

/**
 * Which DATABASE this is — an identity that survives the app's own lifetime and
 * changes when the database is replaced.
 *
 * Derived rather than stored, from the FIRST row the local audit log holds:
 * `row_events` is never trimmed and its id is an autoincrement, so row 1 is the
 * first thing this database ever recorded, and its timestamp never moves. A
 * database that the browser wiped and PowerSync re-created gets a new one,
 * because the re-download writes fresh events.
 *
 * It does NOT identify a DEVICE — restoring a mirror copies the log along with
 * everything else, so two installs can hold the same incarnation. The install
 * id it is paired with in the filename is what separates those.
 *
 * The two ways of having no answer are kept APART because they call for
 * opposite things. An EMPTY log is a positive fact: the triggers fire on every
 * `blocks` write, local and sync-applied alike, so an empty log means no local
 * writes — and therefore nothing in the upload queue either, which is the whole
 * of what this feature protects. There is nothing to copy, so no copy is taken.
 * An UNREADABLE log says nothing about the database; in particular it says
 * nothing about whether the FILE copies, since the export streams raw bytes and
 * runs no query but the checkpoint. A partly damaged database is exactly when a
 * byte copy is worth most, so that copy is taken — under a name no run can ever
 * claim, so it is never ranked against copies of a database it may not be.
 *
 * Ordering by id rather than taking `MIN(created_at)`: a clock that jumps
 * backwards gives a LATER row an earlier timestamp, which would move an
 * identity that is supposed to be fixed — and every copy already in the folder
 * would stop parsing as this database's, falling outside retention for good.
 * The lookup is a rowid seek either way.
 */
export const readDatabaseIncarnation = async (
  repo: ChangeMarkerSource,
): Promise<DatabaseIncarnation> => {
  try {
    const [row] = await repo.db.getAll<{born: number | null}>(
      'SELECT created_at AS born FROM row_events ORDER BY id LIMIT 1',
    )
    return row?.born == null ? {kind: 'empty'} : {kind: 'known', id: String(row.born)}
  } catch (err) {
    console.warn('[db-mirror] could not read the database identity', err)
    return {kind: 'unreadable'}
  }
}

/**
 * The current marker, or `undefined` when the data half cannot be read.
 *
 * Undefined means "no opinion", and the caller must then mirror rather than
 * skip: a missing reading is not evidence that nothing changed.
 */
export const readChangeMarker = async (
  repo: ChangeMarkerSource,
): Promise<string | undefined> => {
  let blocks: string
  try {
    const rows = await repo.db.getAll<{marker: number | null}>(
      'SELECT MAX(id) AS marker FROM row_events',
    )
    blocks = String(rows[0]?.marker ?? 0)
  } catch (err) {
    console.warn('[db-mirror] could not read the change marker; mirroring anyway', err)
    return undefined
  }
  const [queued, rejected] = await Promise.all([
    readQueueFingerprint(repo, 'ps_crud'),
    readQueueFingerprint(repo, 'ps_crud_rejected'),
  ])
  return `${blocks}/${queued}/${rejected}`
}
