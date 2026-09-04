/**
 * The cheap "has anything changed since the last mirror?" reading.
 *
 * `row_events.id` is an AUTOINCREMENT the client schema's triggers advance on
 * every insert, update and delete of `blocks` — local `repo.tx` writes and
 * sync-applied ones alike — so its maximum moves exactly when the data worth
 * copying moves, and reading it is a rowid lookup rather than a scan. That
 * matters because the alternative is copying multiple gigabytes to discover
 * nothing changed.
 *
 * Rejected alternative: PowerSync's `ps_sync_state` checkpoint. It advances on
 * SYNC, so a device working offline all day would mirror nothing — precisely
 * the unsynced local work this feature exists to protect.
 */
import type {Repo} from '@/data/repo'

/** Just enough of `Repo` to read the marker. */
export interface ChangeMarkerSource {
  db: {getAll: <T>(sql: string) => Promise<T[]>}
}

/**
 * The current marker, or `undefined` when it cannot be read.
 *
 * Undefined means "no opinion", and the caller must then mirror rather than
 * skip: a missing reading is not evidence that nothing changed.
 */
export const readChangeMarker = async (
  repo: Repo | ChangeMarkerSource,
): Promise<string | undefined> => {
  try {
    const rows = await (repo as ChangeMarkerSource).db.getAll<{marker: number | null}>(
      'SELECT MAX(id) AS marker FROM row_events',
    )
    return String(rows[0]?.marker ?? 0)
  } catch (err) {
    console.warn('[db-mirror] could not read the change marker; mirroring anyway', err)
    return undefined
  }
}
