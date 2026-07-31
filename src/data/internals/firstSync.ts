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

/** The subset of PowerSync's `SyncStatus` that says whether this device is
 *  currently BEHIND the server, as opposed to whether it has ever synced. */
interface SettleStatus {
  connected?: boolean
  dataFlowStatus?: { downloading?: boolean }
}

interface SettleStatusDb {
  currentStatus?: SettleStatus
  registerListener?: (l: { statusChanged?: (s: SettleStatus) => void }) => () => void
}

const isSettled = (s: SettleStatus | undefined): boolean =>
  s?.connected === true && s.dataFlowStatus?.downloading !== true

/**
 * Run `cb` once this device's download queue looks drained — connected, with
 * no download in flight — firing immediately if that already holds, otherwise
 * on the first status change that satisfies it. Self-disposes; returns a
 * disposer.
 *
 * This is NOT `onFirstSync`, and the difference is the whole point.
 * `hasSynced` persists across sessions, so on any warm client `onFirstSync`
 * fires synchronously and gates nothing — the vacuous-gate trap already
 * documented in `extensions/PanelContentRecovery.tsx`. The dangerous window
 * for a catch-up pass is a device that synced *last week* opening today and
 * writing before it has caught up; only a live download signal sees that.
 *
 * Two deliberate limits:
 *  - a session that never connects never fires (offline, or signed out). Gate
 *    only work that is safe to skip for a session and retry on the next open.
 *  - `connected && !downloading` is briefly true after connecting but before a
 *    queued download starts, so this narrows the window rather than closing it.
 *    Closing it fully needs a "checkpoint completed this session" signal;
 *    combined with the deep-idle deferral its callers already sit behind, the
 *    residual is small.
 */
export const onSyncSettled = (db: SettleStatusDb, cb: () => void): (() => void) => {
  if (typeof db.registerListener !== 'function') {
    // No sync layer at all (tests, local-only stub): nothing to wait for.
    cb()
    return () => {}
  }
  if (isSettled(db.currentStatus)) {
    cb()
    return () => {}
  }
  let done = false
  const dispose = db.registerListener({
    statusChanged: (s) => {
      if (done || !isSettled(s)) return
      done = true
      dispose()
      cb()
    },
  })
  return dispose
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
