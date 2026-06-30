/**
 * User-initiated recovery from a corrupt local database. Two actions, both
 * scoped to the local SQLite files only — they never touch IndexedDB (e2ee
 * workspace keys), the auth session, or the OPFS `assets/` media tree.
 *
 * NOTE: recovery is always manual (offered in the error boundary / settings),
 * never automatic — silently wiping the local DB would lose un-uploaded edits
 * and local history. Always let the user download the old DB first.
 */
import { deleteLocalSqliteDb, downloadBlob, getRawSqliteDbBlob } from './exportSqliteDb'
import { getPowerSyncDb } from '@/data/repoProvider'

export {
  LocalDatabaseCorruptError,
  corruptErrorUserId,
  isLocalDbCorruptionError,
} from './localDbCorruption'

/**
 * Download a copy of the user's local `.db` (the corrupt file included) so they
 * can keep it / recover it offline (`sqlite3 .recover`) BEFORE any reset. Reads
 * the raw OPFS file directly — no read lock, since the corruption path has no
 * working connection. Returns the download filename + byte size.
 */
export const downloadLocalDbBackup = async (
  userId: string,
): Promise<{ filename: string; size: number }> => {
  const { blob, filename } = await getRawSqliteDbBlob(userId)
  downloadBlob(blob, filename)
  return { filename, size: blob.size }
}

/**
 * Reset the local database: close the (possibly failed) PowerSync connection to
 * release the OPFS sync access handle, then delete only the local SQLite files.
 * The caller reloads afterwards so a fresh PowerSync init opens an empty DB and
 * re-syncs from the server.
 */
export const resetLocalDatabase = async (userId: string): Promise<void> => {
  // Best-effort close — mirrors importRawSqliteDb: without releasing the sync
  // access handle, deleting the .db can throw NoModificationAllowedError.
  // Tolerate a failed/absent connection (the corruption path may never have
  // finished opening) and delete anyway.
  try {
    await getPowerSyncDb(userId).close()
  } catch (err) {
    console.warn('[db-recovery] closing the connection before reset failed (continuing):', err)
  }
  await deleteLocalSqliteDb(userId)
}
