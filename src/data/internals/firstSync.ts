/**
 * Await the initial PowerSync download from a structural status surface, shared
 * by the cold-start consumers that each used to hand-roll the same
 * `currentStatus.hasSynced` + `registerListener({statusChanged})` dance (the
 * ANALYZE first-sync re-check in `repoProvider`, the startup-metrics collector).
 */

/** Minimal PowerSync status surface — kept structural so callers don't import
 *  PowerSync types. Satisfied by both the raw PowerSyncDb and the Repo's wrapped
 *  db (a non-PowerSync stub, e.g. in tests, has neither field and is treated as
 *  already-synced). */
export interface SyncStatusDb {
  currentStatus?: { hasSynced?: boolean | null }
  registerListener?: (l: { statusChanged?: (s: { hasSynced?: boolean | null }) => void }) => () => void
}

/** Run `cb` once the initial sync has completed — immediately if it already has
 *  (or there's no sync layer), otherwise on the first `hasSynced` status change.
 *  Self-disposes the listener after firing; returns a disposer for early
 *  teardown. NOTE: in a connected-but-never-synced session (local-only / offline)
 *  the listener simply never fires — callers must not gate required work on it. */
export const onFirstSync = (db: SyncStatusDb, cb: () => void): (() => void) => {
  if (db.currentStatus?.hasSynced || typeof db.registerListener !== 'function') {
    cb()
    return () => {}
  }
  const dispose = db.registerListener({
    statusChanged: (s) => {
      if (s.hasSynced) {
        dispose()
        cb()
      }
    },
  })
  return dispose
}
