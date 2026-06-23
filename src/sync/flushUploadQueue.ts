/**
 * Drain PowerSync's upload queue on demand.
 *
 * Used before the "wipe all local data" panic action (see the
 * `lock_and_wipe_local_data` action in `defaultShortcuts.ts`): clearing site
 * data destroys anything that hasn't reached the server, so we give unsynced
 * edits a best-effort chance to upload first. Draining the queue is the one part
 * of that flow the platform's own "clear site data" can't do for us.
 */

/** Minimal slice of PowerSyncDatabase that {@link flushUploadQueue} needs. */
export interface UploadQueueProbe {
  getUploadQueueStats(includeSize?: boolean): Promise<{ count: number }>
  readonly currentStatus: { connected?: boolean }
  /** PowerSync's sync engine, when connected. We use its `triggerCrudUpload`
   *  to FORCE an immediate upload instead of waiting for the throttled
   *  background scheduler — the user asked to wipe now. Optional/null in
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
 * Drain PowerSync's upload queue, so unsynced edits aren't silently lost when
 * local data is cleared. We don't wait on the throttled background scheduler:
 * each iteration FORCES an immediate upload via `triggerCrudUpload`, then polls
 * {@link UploadQueueProbe.getUploadQueueStats} until it reaches 0.
 *
 * Returns `{flushed:false, remaining}` — rather than blocking — when the queue
 * can't drain: offline (no point waiting) or the timeout elapses while uploads
 * stay stuck (e.g. the server keeps rejecting). The caller then lets the user
 * choose: reconnect and retry, or proceed and lose those edits.
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
  // count to 0 — those unsyncable edits are then lost in the wipe. That's
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
