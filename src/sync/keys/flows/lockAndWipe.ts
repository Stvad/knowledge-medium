/**
 * §6 — Lock & wipe local data (the one destructive whole-DB wipe).
 *
 * "Lock & wipe" is the ONLY action that erases this device's local data. It is
 * deliberate and user-only: nothing automatic triggers it (not a sync event,
 * not a membership revoke, not sign-out — see §9.2). It is NOT a logout; the
 * user stays signed in and synced data re-downloads on the next boot.
 *
 * Sequence (split across two page lifetimes, by necessity):
 *   1. lock time (page is live): {@link flushUploadQueue} drains pending uploads
 *      so unsynced edits aren't lost; then {@link lockAndWipe} arms a
 *      localStorage marker and drops every workspace key (§5). The caller
 *      {@link broadcastWipeReload}s so every OTHER same-user tab reloads too,
 *      then reloads itself.
 *   2. next boot (before the DB opens): {@link consumePendingWipe} deletes the
 *      whole SQLite DB file. It MUST run before PowerSync opens the file —
 *      wa-sqlite can't hold an OPFS sync-access handle on a file being removed —
 *      which is exactly why the file delete is deferred to a fresh boot rather
 *      than done inline at lock time. With multi-tab enabled it retries briefly
 *      to absorb the window where a sibling tab is still releasing the handle.
 *
 * What deliberately SURVIVES the wipe: the mode pins (localStorage, owned by
 * modePin.ts). They are the wipe-surviving authority on each workspace's mode,
 * so an e2ee workspace re-enters its locked read-only state after the wipe
 * (its WK was dropped) instead of being silently downgraded to plaintext.
 *
 * Coarse by design: the whole DB file is wiped rather than per-workspace
 * surgery. Chasing one workspace's plaintext across every local surface (blocks,
 * derived indexes, FTS, caches) is exactly what the coarse file-wipe sidesteps.
 */

import type { WorkspaceKeyStore } from '../keyStore.js'
import { canPersistPins } from '../modePin.js'

// localStorage marker that a wipe is armed for a user's DB. Per-user because the
// SQLite DB file is per-user (kmp-v6-<user_id>.db); a second account in the same
// browser profile must not have its DB wiped by the first. Distinct from the
// mode-pin keys (kmp-e2ee-mode:*), which this flow must never touch.
const PENDING_WIPE_PREFIX = 'kmp-e2ee-pending-wipe:'

const wipeMarkerKey = (userId: string): string =>
  `${PENDING_WIPE_PREFIX}${encodeURIComponent(userId)}`

const hasLocalStorage = (): boolean => {
  try {
    return typeof window !== 'undefined' && window.localStorage !== undefined
  } catch {
    return false
  }
}

/** True if a §6 wipe is armed for this user's DB (consumed on next boot). */
export const isPendingWipe = (userId: string): boolean => {
  if (!hasLocalStorage()) return false
  try {
    return localStorage.getItem(wipeMarkerKey(userId)) === '1'
  } catch {
    return false
  }
}

/** Arm the next-boot DB-file wipe for this user. Throws if localStorage can't
 *  persist — callers (see {@link lockAndWipe}) preflight so this never fires
 *  after keys have been dropped. */
export const markPendingWipe = (userId: string): void => {
  localStorage.setItem(wipeMarkerKey(userId), '1')
}

/** Disarm the wipe (after it has been carried out, or to cancel). */
export const clearPendingWipe = (userId: string): void => {
  if (!hasLocalStorage()) return
  try {
    localStorage.removeItem(wipeMarkerKey(userId))
  } catch {
    // best-effort: a marker we couldn't clear re-wipes a freshly-recreated
    // (empty) DB on the next boot — harmless, and self-heals once writable.
  }
}

/** Minimal slice of PowerSyncDatabase that {@link flushUploadQueue} needs. */
export interface UploadQueueProbe {
  getUploadQueueStats(includeSize?: boolean): Promise<{ count: number }>
  readonly currentStatus: { connected?: boolean }
  /** PowerSync's sync engine, when connected. We use its `triggerCrudUpload`
   *  to FORCE an immediate upload instead of waiting for the throttled
   *  background scheduler — the user asked to lock & wipe now. Optional/null in
   *  not-yet-connected or local-only sessions (and absent in tests that don't
   *  exercise it). */
  readonly syncStreamImplementation?: { triggerCrudUpload: () => void } | null
}

export interface FlushResult {
  /** True once the upload queue reached empty. */
  readonly flushed: boolean
  /** Records still queued (0 when flushed). */
  readonly remaining: number
}

export interface FlushOptions {
  /** Give up waiting after this long and report what's still queued. */
  readonly timeoutMs?: number
  readonly pollMs?: number
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

/**
 * Drain PowerSync's upload queue before a wipe, so unsynced edits aren't
 * silently lost. We don't wait on the throttled background scheduler: each
 * iteration FORCES an immediate upload via `triggerCrudUpload`, then polls
 * {@link UploadQueueProbe.getUploadQueueStats} until it reaches 0.
 *
 * Returns `{flushed:false, remaining}` — rather than blocking — when the queue
 * can't drain: offline (no point waiting) or the timeout elapses while uploads
 * stay stuck (e.g. the server keeps rejecting). The caller then lets the user
 * choose: reconnect and retry, or proceed and lose those edits (§6).
 */
export const flushUploadQueue = async (
  db: UploadQueueProbe,
  opts: FlushOptions = {},
): Promise<FlushResult> => {
  const timeoutMs = opts.timeoutMs ?? 15_000
  const pollMs = opts.pollMs ?? 250
  const now = opts.now ?? (() => Date.now())
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))

  // NOTE: `flushed:true` means the queue DRAINED (count → 0), not that every
  // edit durably reached the server. The connector moves permanently-rejected
  // transactions to `ps_crud_rejected` and completes them, which also drops the
  // count to 0 — those unsyncable edits are then destroyed by the wipe. That's
  // acceptable (they could never sync), but don't over-trust this as "all work
  // persisted".
  let { count } = await db.getUploadQueueStats()
  if (count === 0) return { flushed: true, remaining: 0 }

  const start = now()
  while (count > 0) {
    // Offline: the queue can't drain from here. Report immediately rather than
    // burn the whole timeout — the user can reconnect and re-run the command.
    if (!db.currentStatus.connected) return { flushed: false, remaining: count }
    if (now() - start >= timeoutMs) return { flushed: false, remaining: count }
    // Force the upload NOW instead of waiting for the throttled auto-scheduler.
    // The trigger is leading-edge throttled, so calling it each poll is cheap
    // and keeps pressure on until the queue drains.
    db.syncStreamImplementation?.triggerCrudUpload()
    await sleep(pollMs)
    count = (await db.getUploadQueueStats()).count
  }
  return { flushed: true, remaining: 0 }
}

export interface LockAndWipeDeps {
  /** The signed-in user — keys, pins, and the DB file are all per-user. */
  readonly userId: string
  /** This device's workspace-key store (§5); every WK is dropped. */
  readonly keyStore: WorkspaceKeyStore
}

/**
 * Commit the wipe: arm the next-boot DB-file wipe, then drop every workspace
 * key on this device. Does NOT reload — the caller forces the reload (which also
 * clears the in-memory BlockCache and other live JS state) and the file delete
 * happens on that next boot via {@link consumePendingWipe}.
 *
 * Ordering is the whole point here. The marker is what guarantees the DB (and
 * its plaintext) actually gets removed, so we ARM IT FIRST: if that localStorage
 * write throws, nothing destructive has happened and we just refuse. Only once
 * the wipe is armed do we drop the keys; if the key clear then fails we roll the
 * marker back, so we never strand the dangerous half-state "keys dropped but no
 * wipe armed" (plaintext left on disk with nothing scheduled to remove it). The
 * `canPersistPins()` preflight makes the marker write near-certain, but ordering
 * it first also closes the residual TOCTOU window a sibling tab or quota change
 * could open between the probe and the write.
 */
export const lockAndWipe = async (deps: LockAndWipeDeps): Promise<void> => {
  if (!canPersistPins()) {
    throw new Error(
      'Lock & wipe needs browser storage that is currently unavailable ' +
        '(private mode or storage disabled).',
    )
  }
  markPendingWipe(deps.userId)
  try {
    await deps.keyStore.clearAll()
  } catch (err) {
    // Couldn't drop the keys → undo the arm so we don't wipe a DB whose keys are
    // still present (and don't report success). Rollback is best-effort.
    clearPendingWipe(deps.userId)
    throw err
  }
}

export interface ConsumeWipeOptions {
  /** Extra delete attempts after the first, to absorb the multi-tab window
   *  where a sibling same-user tab is mid-reload and still holds the OPFS
   *  handle. Default 5. */
  readonly retries?: number
  readonly delayMs?: number
  readonly sleep?: (ms: number) => Promise<void>
}

/**
 * Boot-time half of the wipe: if a wipe is armed for this user, delete the DB
 * file, then disarm. MUST run before the DB is opened (see file header).
 *
 * The OPFS remover and filename resolver are injected so this orchestration is
 * unit-testable without a browser; production wires the real OPFS delete +
 * `dbFilenameForUser`. Returns whether a wipe was carried out.
 *
 * Retries the delete a few times: with multi-tab enabled, another same-user tab
 * that received the {@link broadcastWipeReload} signal may still be mid-reload
 * and holding the OPFS sync-access handle, so the first attempt can fail with a
 * "no modification allowed" error that clears within ~a second. If every attempt
 * fails the marker is deliberately LEFT armed and the error propagates (aborting
 * this boot): opening a DB that still holds the just-"wiped" plaintext would
 * break the §6 promise, so we retry on the next boot rather than silently expose
 * it. The thrown message is actionable (close other tabs and reload).
 */
export const consumePendingWipe = async (
  userId: string,
  removeDbFile: (dbFilename: string) => Promise<void>,
  resolveFilename: (userId: string) => string,
  opts: ConsumeWipeOptions = {},
): Promise<boolean> => {
  if (!isPendingWipe(userId)) return false

  const retries = opts.retries ?? 5
  const delayMs = opts.delayMs ?? 200
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const filename = resolveFilename(userId)

  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await removeDbFile(filename)
      clearPendingWipe(userId)
      return true
    } catch (err) {
      lastErr = err
      if (attempt < retries) await sleep(delayMs)
    }
  }
  throw new Error(
    'Could not finish wiping local data — another tab of this app may still be ' +
      'open and holding the database. Close other tabs and reload to finish.',
    { cause: lastErr },
  )
}

// Cross-tab reload signal (BroadcastChannel — the design's §5/§6 cross-tab
// mechanism). With multi-tab enabled, a lock & wipe in one tab must reload the
// OTHER same-user tabs too: otherwise they keep their in-memory plaintext (Repo
// / BlockCache) visible AND keep the OPFS DB handle open, which both leaks the
// "wiped" data and blocks the boot-time file delete.
const WIPE_RELOAD_CHANNEL = 'kmp-e2ee-lock-wipe'

const hasBroadcastChannel = (): boolean => typeof BroadcastChannel !== 'undefined'

/** Tell every other tab for `userId` to reload (so they drop plaintext and
 *  release the DB handle before the wipe). Best-effort; a missing
 *  BroadcastChannel just means other tabs re-lock on their own next reload
 *  (the pin survives, so no downgrade). */
export const broadcastWipeReload = (userId: string): void => {
  if (!hasBroadcastChannel()) return
  try {
    const channel = new BroadcastChannel(WIPE_RELOAD_CHANNEL)
    channel.postMessage({ type: 'wipe-reload', userId })
    channel.close()
  } catch {
    // ignore — see doc above
  }
}

/** Subscribe this tab to wipe-reload signals for `userId`; runs `onReload`
 *  (production: a full page reload) on a match. Returns an unsubscribe. */
export const onWipeReload = (userId: string, onReload: () => void): (() => void) => {
  if (!hasBroadcastChannel()) return () => {}
  let channel: BroadcastChannel
  try {
    channel = new BroadcastChannel(WIPE_RELOAD_CHANNEL)
  } catch {
    return () => {}
  }
  const handler = (event: MessageEvent) => {
    const data = event.data as { type?: string; userId?: string } | null
    if (data?.type === 'wipe-reload' && data.userId === userId) onReload()
  }
  channel.addEventListener('message', handler)
  return () => {
    channel.removeEventListener('message', handler)
    channel.close()
  }
}
