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
import { closePowerSyncDbIfOpen } from '@/data/repoProvider'

export {
  LocalDatabaseCorruptError,
  corruptErrorUserId,
  isLocalDbCorruptionError,
} from './localDbCorruption'

/**
 * Download a copy of the user's local `.db` (the corrupt file included) so they
 * can keep it / recover it offline (`sqlite3 .recover`) BEFORE any reset.
 *
 * Releases any held OPFS sync access handle first (the failed corruption open
 * may still hold one — OPFSCoopSyncVFS releases cooperatively but not on a
 * guaranteed schedule), then reads the raw file directly. Returns the download
 * filename + byte size.
 */
export const downloadLocalDbBackup = async (
  userId: string,
): Promise<{ filename: string; size: number }> => {
  await closePowerSyncDbIfOpen(userId)
  const { blob, filename } = await getRawSqliteDbBlob(userId)
  downloadBlob(blob, filename)
  return { filename, size: blob.size }
}

/**
 * Reset the local database: close the (possibly failed) PowerSync connection to
 * release the OPFS sync access handle, then delete only the local SQLite files.
 * The caller reloads afterwards so a fresh PowerSync init opens an empty DB and
 * (for a remote-sync session) re-syncs from the server.
 *
 * If the delete can't fully complete (e.g. another tab still holds the OPFS
 * handle), `deleteLocalSqliteDb` throws WITHOUT removing the main `.db` — the
 * caller surfaces that and does NOT reload, so we never boot onto a half-deleted
 * DB.
 */
export const resetLocalDatabase = async (userId: string): Promise<void> => {
  // Release the handle WITHOUT constructing a new connection to the file we're
  // about to delete (that would re-acquire the handle and re-fail on the corrupt
  // bytes). Tolerate a failed/absent connection — the corruption path may never
  // have finished opening.
  try {
    await closePowerSyncDbIfOpen(userId)
  } catch (err) {
    console.warn('[db-recovery] closing the connection before reset failed (continuing):', err)
  }
  await deleteLocalSqliteDb(userId)
}
