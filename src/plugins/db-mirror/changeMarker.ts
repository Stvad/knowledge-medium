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
 * `ps_crud` is the pending-upload queue, and it is in here for a restore-safety
 * reason rather than a data one. Draining the queue writes nothing to `blocks`,
 * so on the `row_events` reading alone a mirror taken while an upload was still
 * pending would keep that pending entry FOREVER once the user stops editing.
 * Restoring it replays the patch — and patches are column-LWW, so a value
 * another device has since changed gets overwritten by the stale one. Sampling
 * the queue costs one small query and converges the newest copy on a drained
 * queue, at the price of roughly one extra copy per editing session.
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

const readQueueFingerprint = async (repo: ChangeMarkerSource): Promise<string> => {
  try {
    const [row] = await repo.db.getAll<{n: number; last: number | null}>(
      'SELECT COUNT(*) AS n, MAX(id) AS last FROM ps_crud',
    )
    // Both, because either alone is blind to a case: the count misses a queue
    // that gained and drained an entry between runs, and the id misses a drain.
    return `${row?.n ?? 0}.${row?.last ?? 0}`
  } catch (err) {
    console.warn('[db-mirror] could not read the upload queue', err)
    return QUEUE_UNKNOWN
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
  return `${blocks}/${await readQueueFingerprint(source)}`
}
