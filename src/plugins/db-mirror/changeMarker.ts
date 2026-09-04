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
 * `ps_crud` is the pending-upload queue. Draining it writes nothing to
 * `blocks`, so on the `row_events` reading alone a mirror taken while an upload
 * was still pending would keep that pending entry FOREVER once the user stops
 * editing. Restoring it replays the patch — and patches are column-LWW, so a
 * value another device has since changed gets overwritten by the stale one.
 *
 * `ps_crud_rejected` is the quarantine for uploads the server refused, and it
 * qualifies under the same rule because the rejection dialog's Retry button
 * puts a row straight back into `ps_crud`. A restore that resurrects a
 * rejection the user had dismissed offers them one click to upload a patch that
 * is now stale.
 *
 * Sampling both costs two small queries and converges the newest copy on drained
 * queues, at the price of roughly one extra copy per editing session.
 *
 * Rejected alternative for the first part: PowerSync's `ps_sync_state`
 * checkpoint. It advances on SYNC, so a device working offline all day would
 * mirror nothing — precisely the unsynced local work this feature protects.
 */
import type {Repo} from '@/data/repo'

/** Just enough of `Repo` to read the marker. */
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
 * Derived rather than stored, from the oldest event the local audit log holds:
 * `row_events` is never trimmed, so its first row is effectively the moment
 * this database first recorded anything. Two devices do not share it, and a
 * database that the browser wiped and PowerSync re-created gets a new one,
 * because the re-download writes fresh events.
 *
 * That matters for two things this feature cannot otherwise get right. A copy
 * on disk belongs to ONE database, so a shared or cloud-synced folder must not
 * let one device's pruning delete another's backups; and after the OPFS loss
 * this feature exists for, the fresh database's first copy must not evict the
 * pre-loss copy that holds the work the loss took.
 *
 * `undefined` when it cannot be read or the log is empty. Callers treat that as
 * "a database I know nothing about": copy, and prune nothing that is not
 * plainly this run's own.
 */
export const readDatabaseIncarnation = async (
  repo: Repo | ChangeMarkerSource,
): Promise<string | undefined> => {
  try {
    const [row] = await (repo as ChangeMarkerSource).db.getAll<{
      first: number | null
      born: number | null
    }>('SELECT MIN(id) AS first, MIN(created_at) AS born FROM row_events')
    if (row?.born == null) return undefined
    return `${row.first ?? 0}.${row.born}`
  } catch (err) {
    console.warn('[db-mirror] could not read the database identity', err)
    return undefined
  }
}

/**
 * The current marker, or `undefined` when the data half cannot be read.
 *
 * Undefined means "no opinion", and the caller must then mirror rather than
 * skip: a missing reading is not evidence that nothing changed.
 */
export const readChangeMarker = async (
  repo: Repo | ChangeMarkerSource,
): Promise<string | undefined> => {
  const source = repo as ChangeMarkerSource
  let blocks: string
  try {
    const rows = await source.db.getAll<{marker: number | null}>(
      'SELECT MAX(id) AS marker FROM row_events',
    )
    blocks = String(rows[0]?.marker ?? 0)
  } catch (err) {
    console.warn('[db-mirror] could not read the change marker; mirroring anyway', err)
    return undefined
  }
  const [queued, rejected] = await Promise.all([
    readQueueFingerprint(source, 'ps_crud'),
    readQueueFingerprint(source, 'ps_crud_rejected'),
  ])
  return `${blocks}/${queued}/${rejected}`
}
