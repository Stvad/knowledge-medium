/**
 * Close a PowerSync connection and release its OPFS sync access handle, EVEN
 * when the connection's initialization rejected (corrupt DB).
 *
 * `PowerSyncDatabase.close()` awaits `waitForReady()` first, so on a `.db` whose
 * init rejected ("database disk image is malformed") it re-throws the init error
 * BEFORE it reaches the adapter close that actually releases the handle. The
 * underlying adapter (`.database`) is constructed up front — `openDB()` runs in
 * the `PowerSyncDatabase` constructor, before `initialize()` — so closing it
 * directly tears down the worker/handle regardless of init state. Without this,
 * a subsequent `deleteLocalSqliteDb` can fail as locked and strand the user
 * unable to reset the corrupt DB.
 *
 * Best-effort: if both the high-level close and the adapter close throw, there's
 * nothing more we can do here — the caller surfaces the later delete failure.
 */
export interface ReleasableConnection {
  close: () => Promise<void>
  database: { close: () => void | Promise<void> }
}

export const releasePowerSyncConnection = async (db: ReleasableConnection): Promise<void> => {
  try {
    await db.close()
  } catch {
    // High-level close re-threw a rejected init; release the adapter directly.
    try {
      await db.database.close()
    } catch (adapterErr) {
      console.warn('[db-recovery] adapter close fallback failed after close() rejected:', adapterErr)
    }
  }
}
