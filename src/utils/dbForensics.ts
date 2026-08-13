/**
 * Out-of-band forensic breadcrumbs for local-DB corruption.
 *
 * The recurring iPad OPFS corruptions (issue #284, [[ipad-opfs-corruption-1gib-page]])
 * give us a clear END STATE but no record of the SEQUENCE that produced it, so
 * we can't discriminate the candidate mechanisms (non-durable flush on process
 * kill vs a WebKit-OPFS boundary bug vs a coop-lock/handle issue). This module
 * records the breadcrumbs that would tell them apart, and captures a full
 * forensic snapshot the moment corruption is detected.
 *
 * Everything here lives in IndexedDB, NOT in the OPFS SQLite file — the thing we
 * are debugging is that file being corrupt, so forensic state must survive it.
 * It is strictly best-effort: every public method swallows its own errors, so a
 * failure to record instrumentation can never break boot, sync, or recovery.
 *
 * Dependency-free of `repoProvider`/`repo` (like `localDbCorruption`): callers
 * pass the resolved `.db` filename and any DB-side context, so this can be
 * imported from the DB-open path without a cycle.
 */

import { IdbKeyedStore } from '@/utils/idbKeyedStore.js'
import { scanForZeroPages, type OpfsPageScanResult } from '@/utils/opfsPageScan.js'

const FORENSICS_DB = 'km-db-forensics'
const FORENSICS_STORE = 'forensics'

const CURRENT_SESSION_KEY = 'session:current'
const META_KEY = 'meta'
const UNCLEAN_PREFIX = 'unclean:'
const SNAPSHOT_PREFIX = 'snapshot:'
const SYNC_CURRENT_KEY = 'sync:current'
// NOT `sync:` — `trimByPrefix` sorts keys under a prefix by
// `parseInt(key.slice(prefix.length))` (see `tsOf`); if archives lived under
// `sync:` then a scan for that prefix would also match `sync:current`, and
// `parseInt('current')` is `NaN` → `tsOf` coerces it to 0 → the CURRENT ring
// would sort as the oldest entry and be the first one the trim deletes. A
// distinct prefix keeps `sync:current` out of the archive scan entirely.
const SYNC_ARCHIVE_PREFIX = 'syncsession:'

const MAX_SESSION_EVENTS = 24
const MAX_UNCLEAN_ARCHIVES = 20
const MAX_SNAPSHOTS = 10
/** Cap on the live sync-health ring. Coalescing (see {@link DbForensics.recordSyncSample})
 *  is what keeps this cheap even under a long stall: a 16-hour stall that never
 *  changes state is ONE entry, not thousands. */
export const MAX_SYNC_SAMPLES = 60
export const MAX_SYNC_ARCHIVES = 5

const DB_FILE_SIBLING_SUFFIXES = ['-journal', '-wal', '-shm'] as const

export interface ForensicSessionRecord {
  startedAt: number
  lastSeenAt: number
  /** True only after a graceful `pagehide`. On mobile this is frequently false
   *  (the OS reaps a backgrounded tab with no unload ceremony) — so DON'T read
   *  it as "process killed" on its own; pair it with `lastVisibilityState` and
   *  `events`: unclean + `hidden` = backgrounded-then-reaped (common, benign);
   *  unclean + `visible` = killed while foreground-active (the rarer, more
   *  suspicious fingerprint). */
  cleanShutdown: boolean
  /** Visibility as of session start or the last `visibilitychange` — the
   *  discriminator above. (Not refreshed by pagehide/resume, but a
   *  `visibilitychange:hidden` reliably precedes those, so it's the right value.) */
  lastVisibilityState: string | null
  userId: string
  userAgent: string
  dbSizeAtStart: number | null
  events: Array<{ t: number; type: string }>
}

interface ForensicsMeta {
  uncleanShutdownCount: number
}

export interface OpfsInventoryEntry {
  name: string
  kind: 'file' | 'directory'
  size: number | null
}

export interface CorruptionSnapshot {
  at: number
  reason: string
  userAgent: string
  dbFilename: string
  session: ForensicSessionRecord | null
  meta: ForensicsMeta
  opfs: OpfsInventoryEntry[] | { error: string }
  estimate: { usage?: number; quota?: number } | { error: string }
  scan: OpfsPageScanResult | { error: string } | null
  /** Caller-supplied DB-side context (downloadError, ps_buckets, which tables
   *  fail) — this module can't reach the live SQL connection itself. */
  sql?: unknown
}

/**
 * One observation (or run of identical observations — see `count`) of the
 * PowerSync connection + queue state. The 2026-08-13 iPad incident (22 blocks
 * stuck in `ps_crud` for 16.3 hours, four restarts that didn't drain it) left
 * no record of sync state over time — only the crash breadcrumbs. This is
 * that record: {@link DbForensics.recordSyncSample} coalesces a run of
 * identical samples into one entry (`t`→`lastT`, incrementing `count`) so a
 * multi-hour stall costs one ring slot instead of overflowing it.
 */
export interface SyncHealthSample {
  /** First observation of this state. */
  t: number
  /** Most recent observation of this state (== `t` until coalesced). */
  lastT: number
  /** Observations coalesced into this entry. */
  count: number
  connected: boolean
  connecting: boolean
  hasSynced: boolean | null
  /** Epoch ms, or null if never synced. NOT part of the coalescing key (it
   *  advances on every download checkpoint even on an otherwise-unchanging
   *  healthy connection) — on a coalesced entry this is the value AS OF
   *  `lastT`, not `t`; it is updated in place each time the entry absorbs a
   *  new observation, so it never reads as frozen/stale on a healthy entry. */
  lastSyncedAt: number | null
  /** NOT part of the coalescing key (churns on every checkpoint); updated to
   *  the newest value on each coalesce, same as `lastSyncedAt`. */
  uploading: boolean
  /** NOT part of the coalescing key (churns on every checkpoint); updated to
   *  the newest value on each coalesce, same as `lastSyncedAt`. */
  downloading: boolean
  /** Raw `ps_crud` row count (capped). Null if the count query failed. */
  pendingRows: number | null
  /** Distinct blocks queued for upload — matches what the status chip shows. Null if the count query failed. */
  pendingBlocks: number | null
  /** Epoch ms the CURRENT unbroken run of `pendingBlocks > 0` began, or null
   *  when the queue is empty (or its count is unknown — see the caller's
   *  handling in dbForensicsHooks.ts). IS part of the coalescing key: it stays
   *  constant for the life of one pending-queue episode, so a change (queue
   *  drained and refilled, or an unknown→known transition) correctly starts a
   *  new ring entry instead of silently extending the wrong episode. */
  pendingSinceT: number | null
  rejected: number | null
  materializing: number | null
  uploadError: string | null
  downloadError: string | null
  /** Caller-computed: the queue is non-empty AND (the connection hasn't synced
   *  in a while OR the queue itself has been non-empty for a while). The
   *  second disjunct is what catches a wedged-upload/healthy-download split —
   *  `lastSyncedAt` alone advances on every download and would stay "fresh"
   *  through exactly that failure mode. */
  stall: boolean
}

interface SyncHealthRing {
  startedAt: number
  samples: SyncHealthSample[]
}

const STALL_PREFIX = 'stall:'
export const MAX_STALL_EPISODES = 10

/**
 * A durable log entry for one stall episode — deliberately a SEPARATE store
 * from the sync-sample ring (`sync:current`), because the ring's coalescing
 * (which absorbs healthy churn to keep the ring small) is exactly what would
 * evict a resolved stall minutes after it clears on a busy client. This is
 * append-once-then-patch-once: written on the not-stalled→stalled transition,
 * patched exactly once more (the `cleared*` fields) on stalled→not-stalled,
 * and otherwise untouched — so it survives however long the ring itself
 * churns past it.
 */
export interface StallEpisode extends Omit<SyncHealthSample, 'lastT' | 'count'> {
  /** Set once the stall clears (stalled→not-stalled transition). Absent while
   *  the episode is still open — an open entry in the dump means the stall
   *  was never observed to resolve (e.g. the tab was closed mid-stall). */
  clearedAt?: number
  /** State AS OF the clearing sample — HOW the stall resolved. This was the
   *  single most informative fact missing from the 2026-08-13 incident: the
   *  queue flushed unattended at 20:13:28 and nothing recorded why (Did the
   *  connection recover first? Did the queue just... drain? Was it a
   *  foreground transition?). */
  clearedConnected?: boolean
  clearedLastSyncedAt?: number | null
  clearedPendingBlocks?: number | null
  /** How many times the reconnect watchdog (dbForensicsHooks.ts
   *  `runReconnectWatchdog`) has fired `sync.reconnect` against THIS
   *  episode. Absent means the watchdog never attempted — e.g. it wasn't
   *  armed (local-only session) or the episode closed before the first
   *  backoff-eligible sample. Set via {@link DbForensics.recordStallReconnectAttempt}. */
  reconnectAttempts?: number
  /** Epoch ms of the watchdog's most recent attempt against this episode.
   *  Paired with `reconnectAttempts` and `clearedAt` this is what answers
   *  "did the watchdog fire, and did it help" from the dump alone — the
   *  2026-08-13 incident had no lever at all, automatic or manual, so
   *  there was nothing to even ask this question about. */
  lastReconnectAttemptAt?: number
}

const VISIBILITY_PREFIX = 'visibility:'

const warn = (msg: string, err: unknown): void =>
  console.warn(`[db-forensics] ${msg}`, err)

/**
 * Best-effort forensic recorder. Construct with a custom store only in tests;
 * production uses the {@link dbForensics} singleton.
 */
export class DbForensics {
  constructor(
    private readonly store: IdbKeyedStore = new IdbKeyedStore(FORENSICS_DB, FORENSICS_STORE),
  ) {}

  // Serializes the read-modify-write ops on `session:current`. Without this,
  // back-to-back lifecycle events (e.g. visibilitychange then pagehide) each do
  // an independent get→put and the later put, built from a pre-clean snapshot,
  // clobbers `cleanShutdown: true` — turning a clean exit into a false unclean.
  private sessionMutex: Promise<unknown> = Promise.resolve()
  // Serializes the read-modify-write ops on `sync:current`. Kept SEPARATE from
  // `sessionMutex` on purpose: sync samples can arrive every 60s (or on every
  // `statusChanged`) and must not queue behind — or block — lifecycle event
  // writes (visibilitychange, pagehide), and vice versa.
  private syncMutex: Promise<unknown> = Promise.resolve()
  // Disambiguates snapshots captured in the same millisecond (the scan-time and
  // runtime-corruption capturers can fire together) so neither overwrites the other.
  private snapshotSeq = 0

  private get<T>(key: string): Promise<T | undefined> {
    return this.store.tx('readonly', s => s.get(key) as IDBRequest<T | undefined>)
  }

  private async put(key: string, value: unknown): Promise<void> {
    await this.store.tx('readwrite', s => s.put(value, key))
  }

  /** Run `op` after all previously-enqueued session mutations complete. `op`
   *  never rejects (bodies self-catch); the chain still guards against it. */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const result = this.sessionMutex.then(op, op)
    this.sessionMutex = result.then(() => undefined, () => undefined)
    return result
  }

  /** Same contract as {@link enqueue}, chained on `syncMutex` instead. */
  private enqueueSync<T>(op: () => Promise<T>): Promise<T> {
    const result = this.syncMutex.then(op, op)
    this.syncMutex = result.then(() => undefined, () => undefined)
    return result
  }

  /**
   * Open a new session and detect whether the PREVIOUS one ended uncleanly (no
   * graceful `pagehide` before the process died). Returns whether the last
   * session was unclean plus the running count. Best-effort: on any failure
   * returns a benign default.
   */
  recordSessionStart(opts: { userId: string; dbFilename: string }): Promise<{
    uncleanShutdown: boolean
    uncleanShutdownCount: number
  }> {
    return this.enqueue(async () => {
      try {
        const previous = await this.get<ForensicSessionRecord>(CURRENT_SESSION_KEY)
        const meta = (await this.get<ForensicsMeta>(META_KEY)) ?? { uncleanShutdownCount: 0 }
        let uncleanShutdown = false

        if (previous && !previous.cleanShutdown) {
          uncleanShutdown = true
          meta.uncleanShutdownCount += 1
          await this.put(`${UNCLEAN_PREFIX}${previous.startedAt}`, previous)
          await this.trimByPrefix(UNCLEAN_PREFIX, MAX_UNCLEAN_ARCHIVES)
          await this.put(META_KEY, meta)
        }

        const now = Date.now()
        const session: ForensicSessionRecord = {
          startedAt: now,
          lastSeenAt: now,
          cleanShutdown: false,
          lastVisibilityState: typeof document !== 'undefined' ? document.visibilityState : null,
          userId: opts.userId,
          userAgent: navigator.userAgent,
          dbSizeAtStart: await safeDbSize(opts.dbFilename),
          events: [{ t: now, type: 'start' }],
        }
        await this.put(CURRENT_SESSION_KEY, session)

        // Archive the outgoing sync-health ring (the thing missing in the
        // 2026-08-13 iPad incident: the forensics store recorded the restarts
        // but nothing about sync state). Runs on the SEPARATE sync mutex so it
        // can't race a concurrent `recordSyncSample`'s read-modify-write of
        // `sync:current`. Independently try/caught: a failure here must not
        // clobber the unclean-shutdown result already computed above.
        try {
          await this.enqueueSync(() => this.archiveSyncRing(now))
        } catch (err) {
          warn('recordSessionStart: sync ring archive failed', err)
        }

        return { uncleanShutdown, uncleanShutdownCount: meta.uncleanShutdownCount }
      } catch (err) {
        warn('recordSessionStart failed', err)
        return { uncleanShutdown: false, uncleanShutdownCount: 0 }
      }
    })
  }

  /** Archive `sync:current` (if present) under `SYNC_ARCHIVE_PREFIX<startedAt>`,
   *  trim old archives, then reset `sync:current` to a fresh empty ring dated
   *  `now`. MUST be invoked already serialized on `syncMutex` (see the two call
   *  sites: {@link recordSessionStart} and nowhere else). */
  private async archiveSyncRing(now: number): Promise<void> {
    const previous = await this.get<SyncHealthRing>(SYNC_CURRENT_KEY)
    if (previous) {
      await this.put(`${SYNC_ARCHIVE_PREFIX}${previous.startedAt}`, previous)
      await this.trimByPrefix(SYNC_ARCHIVE_PREFIX, MAX_SYNC_ARCHIVES)
    }
    await this.put(SYNC_CURRENT_KEY, { startedAt: now, samples: [] } satisfies SyncHealthRing)
  }

  /**
   * Record one sync-health observation. COALESCING is the core requirement: if
   * the last entry in the ring is identical to `sample` in every field except
   * `t`/`lastT`/`count`, don't append — advance its `lastT` and increment
   * `count`. This is what turns a 16-hour stall into one legible entry
   * ("pending=22, connected=false, from T1 to T2, 963 observations") instead of
   * overflowing the ring with duplicates. Otherwise append (capped at
   * {@link MAX_SYNC_SAMPLES}, dropping the oldest). Best-effort: swallows and
   * warns, never throws. Serialized on `syncMutex` — separate from the session
   * mutex so lifecycle events and sync samples never block each other.
   */
  recordSyncSample(sample: Omit<SyncHealthSample, 'lastT' | 'count'>): Promise<void> {
    return this.enqueueSync(async () => {
      try {
        const ring = (await this.get<SyncHealthRing>(SYNC_CURRENT_KEY)) ?? {
          startedAt: sample.t,
          samples: [],
        }
        const last = ring.samples[ring.samples.length - 1]
        if (last && sameSyncState(last, sample)) {
          last.lastT = sample.t
          last.count += 1
          // lastSyncedAt/uploading/downloading churn on every checkpoint even
          // on a healthy connection (see sameSyncState — deliberately NOT part
          // of the coalescing key), so refresh them to the newest observed
          // value. Without this the retained entry would freeze at whatever
          // it was on FIRST absorbing this state, misreporting "as of t" values
          // as current.
          last.lastSyncedAt = sample.lastSyncedAt
          last.uploading = sample.uploading
          last.downloading = sample.downloading
        } else {
          ring.samples = appendCapped(
            ring.samples,
            { ...sample, lastT: sample.t, count: 1 },
            MAX_SYNC_SAMPLES,
          )
        }
        await this.put(SYNC_CURRENT_KEY, ring)
      } catch (err) {
        warn('recordSyncSample failed', err)
      }
    })
  }

  /**
   * Open a durable stall-episode record, keyed by the triggering sample's `t`
   * (`stall:<t>`) — see {@link StallEpisode} for why this is a separate store
   * from the coalescing ring. Trimmed to {@link MAX_STALL_EPISODES}, oldest
   * dropped. Returns the key so the caller can later {@link closeStallEpisode}
   * it (this store has no notion of "the currently open episode" — that's the
   * caller's, e.g. the watcher's, state to track), or `null` on failure.
   * Best-effort: never throws. Serialized on `syncMutex`, same as
   * {@link recordSyncSample}.
   */
  recordStallEpisode(sample: Omit<SyncHealthSample, 'lastT' | 'count'>): Promise<string | null> {
    return this.enqueueSync(async () => {
      try {
        const key = `${STALL_PREFIX}${sample.t}`
        await this.put(key, { ...sample } satisfies StallEpisode)
        await this.trimByPrefix(STALL_PREFIX, MAX_STALL_EPISODES)
        return key
      } catch (err) {
        warn('recordStallEpisode failed', err)
        return null
      }
    })
  }

  /**
   * Patch a previously-opened stall episode with how it resolved. No-op if
   * `key` is null (the open-call failed, or there's nothing to close) or the
   * episode was already trimmed out of the log. Best-effort: never throws.
   */
  closeStallEpisode(
    key: string | null,
    clearing: { clearedAt: number; connected: boolean; lastSyncedAt: number | null; pendingBlocks: number | null },
  ): Promise<void> {
    return this.enqueueSync(async () => {
      if (!key) return
      try {
        const episode = await this.get<StallEpisode>(key)
        if (!episode) return
        episode.clearedAt = clearing.clearedAt
        episode.clearedConnected = clearing.connected
        episode.clearedLastSyncedAt = clearing.lastSyncedAt
        episode.clearedPendingBlocks = clearing.pendingBlocks
        await this.put(key, episode)
      } catch (err) {
        warn('closeStallEpisode failed', err)
      }
    })
  }

  /**
   * Record one reconnect-watchdog attempt (dbForensicsHooks.ts
   * `runReconnectWatchdog`) against the CURRENTLY OPEN stall episode —
   * increments `reconnectAttempts` and stamps `lastReconnectAttemptAt`. Same
   * shape as {@link closeStallEpisode}: a no-op if `key` is null (nothing
   * open) or the episode was already trimmed out; best-effort, never throws.
   * Called once per watchdog attempt, independent of whether the reconnect
   * itself succeeds — the attempt happened either way, and whether it helped
   * shows up in whether/when the episode later closes.
   *
   * The `if (!key) return` is defence in depth, not the only thing standing
   * between a null key and a write: `this.get(null)` also fails (IndexedDB
   * rejects a null key) and is caught by the `try`/`catch` below, so removing
   * the early return alone doesn't change observable behavior — it's kept for
   * the same reason {@link closeStallEpisode}'s does: skip the doomed
   * get/catch round-trip and make "nothing open" an explicit, cheap case
   * rather than an incidental error path.
   */
  recordStallReconnectAttempt(key: string | null, attemptedAt: number): Promise<void> {
    return this.enqueueSync(async () => {
      if (!key) return
      try {
        const episode = await this.get<StallEpisode>(key)
        if (!episode) return
        episode.reconnectAttempts = (episode.reconnectAttempts ?? 0) + 1
        episode.lastReconnectAttemptAt = attemptedAt
        await this.put(key, episode)
      } catch (err) {
        warn('recordStallReconnectAttempt failed', err)
      }
    })
  }

  /** Mark the current session as ended cleanly. Call on `pagehide`. */
  markCleanShutdown(): Promise<void> {
    return this.setCleanShutdown(true, 'clean-shutdown')
  }

  /** Un-mark clean shutdown — the session is live again (bfcache `pageshow` /
   *  Page-Lifecycle `resume`). Without this, a `pagehide`→restore→hard-kill
   *  sequence would read as clean on the next boot (false negative). */
  clearCleanShutdown(): Promise<void> {
    return this.setCleanShutdown(false, 'resume')
  }

  private setCleanShutdown(value: boolean, eventType: string): Promise<void> {
    return this.enqueue(async () => {
      try {
        const current = await this.get<ForensicSessionRecord>(CURRENT_SESSION_KEY)
        if (!current) return
        current.cleanShutdown = value
        current.lastSeenAt = Date.now()
        current.events = appendCapped(current.events, { t: current.lastSeenAt, type: eventType })
        await this.put(CURRENT_SESSION_KEY, current)
      } catch (err) {
        warn('setCleanShutdown failed', err)
      }
    })
  }

  /** Append a lifecycle breadcrumb (visibilitychange / freeze / resume …). */
  recordLifecycleEvent(type: string): Promise<void> {
    return this.enqueue(async () => {
      try {
        const current = await this.get<ForensicSessionRecord>(CURRENT_SESSION_KEY)
        if (!current) return
        const now = Date.now()
        current.lastSeenAt = now
        if (type.startsWith(VISIBILITY_PREFIX)) {
          current.lastVisibilityState = type.slice(VISIBILITY_PREFIX.length)
        }
        current.events = appendCapped(current.events, { t: now, type })
        await this.put(CURRENT_SESSION_KEY, current)
      } catch (err) {
        warn('recordLifecycleEvent failed', err)
      }
    })
  }

  /**
   * Gather and persist a full forensic snapshot: OPFS inventory + sizes, storage
   * estimate, a zero-page scan (reused if the caller already ran one), the
   * current session + unclean-shutdown count, and any caller-supplied DB-side
   * context. Call on `SQLITE_CORRUPT` detection.
   *
   * NOTE: the byte scan (`safeScan`) reads the live OPFS `.db` unlocked. That's
   * acceptable here because it only runs on the corruption path, where the sync
   * worker is already failing to APPLY (not committing writes), so torn reads are
   * unlikely; and it's best-effort — a throw just yields `{error}` while the
   * cheap fields (inventory/estimate/session/sql) are still captured. We do NOT
   * scan on every boot (that unlocked full-file read would contend with the live
   * writer and could report torn-write false positives).
   */
  async captureCorruptionSnapshot(opts: {
    userId: string
    dbFilename: string
    reason: string
    sql?: unknown
    scan?: OpfsPageScanResult
  }): Promise<CorruptionSnapshot | null> {
    try {
      const session = (await this.get<ForensicSessionRecord>(CURRENT_SESSION_KEY)) ?? null
      const meta = (await this.get<ForensicsMeta>(META_KEY)) ?? { uncleanShutdownCount: 0 }
      const at = Date.now()
      const snapshot: CorruptionSnapshot = {
        at,
        reason: opts.reason,
        userAgent: navigator.userAgent,
        dbFilename: opts.dbFilename,
        session,
        meta,
        opfs: await safeOpfsInventory(opts.dbFilename),
        estimate: await safeStorageEstimate(),
        scan: opts.scan ?? (await safeScan(opts.dbFilename)),
        sql: opts.sql,
      }
      await this.put(`${SNAPSHOT_PREFIX}${at}-${this.snapshotSeq++}`, snapshot)
      await this.trimByPrefix(SNAPSHOT_PREFIX, MAX_SNAPSHOTS)
      return snapshot
    } catch (err) {
      warn('captureCorruptionSnapshot failed', err)
      return null
    }
  }

  /** Dump everything for download/inspection. Best-effort. */
  async exportAll(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {}
    try {
      await this.store.scanByPrefix('readonly', '', cursor => {
        out[String(cursor.key)] = cursor.value
      })
    } catch (err) {
      warn('exportAll failed', err)
    }
    return out
  }

  /** Keep only the newest `keep` records under `prefix` (keys are `<prefix><ts>[-seq]`). */
  private async trimByPrefix(prefix: string, keep: number): Promise<void> {
    const keys: string[] = []
    await this.store.scanByPrefix('readonly', prefix, cursor => {
      if (typeof cursor.key === 'string') keys.push(cursor.key)
    })
    if (keys.length <= keep) return
    keys.sort((a, b) => tsOf(a, prefix) - tsOf(b, prefix))
    const doomed = keys.slice(0, keys.length - keep)
    for (const key of doomed) {
      await this.store.tx('readwrite', s => s.delete(key))
    }
  }
}

/** App singleton. */
export const dbForensics = new DbForensics()

// Leading-timestamp of a `<prefix><ts>[-seq]` key. `parseInt` stops at the `-`,
// so a `snapshot:<at>-<seq>` key still sorts by its timestamp; a malformed key
// coerces to 0 (trimmed first), never deleting a live newer record.
const tsOf = (key: string, prefix: string): number => {
  const parsed = parseInt(key.slice(prefix.length), 10)
  return Number.isNaN(parsed) ? 0 : parsed
}

const appendCapped = <T>(arr: T[], item: T, cap = MAX_SESSION_EVENTS): T[] => {
  const next = [...arr, item]
  return next.length > cap ? next.slice(next.length - cap) : next
}

// Every field except t/lastT/count — the coalescing test for recordSyncSample.
// Every field except t/lastT/count — the coalescing test for recordSyncSample.
// Deliberately EXCLUDES lastSyncedAt/uploading/downloading: those churn on
// every checkpoint even on an otherwise-unchanging healthy connection, so
// including them would fragment the ring into a few minutes of history
// instead of real state transitions (a coalesced entry still tracks their
// newest value — see the update in recordSyncSample — it just isn't part of
// what decides whether to coalesce). `pendingSinceT` IS included: it's
// constant for the life of one pending-queue episode, so a change (drained
// and refilled) correctly starts a new entry.
const sameSyncState = (
  a: SyncHealthSample,
  b: Omit<SyncHealthSample, 'lastT' | 'count'>,
): boolean =>
  a.connected === b.connected &&
  a.connecting === b.connecting &&
  a.hasSynced === b.hasSynced &&
  a.pendingRows === b.pendingRows &&
  a.pendingBlocks === b.pendingBlocks &&
  a.pendingSinceT === b.pendingSinceT &&
  a.rejected === b.rejected &&
  a.materializing === b.materializing &&
  a.uploadError === b.uploadError &&
  a.downloadError === b.downloadError &&
  a.stall === b.stall

const openOpfsFile = async (name: string): Promise<File | null> => {
  try {
    const root = await navigator.storage.getDirectory()
    const handle = await root.getFileHandle(name)
    return await handle.getFile()
  } catch {
    return null
  }
}

const safeDbSize = async (dbFilename: string): Promise<number | null> => {
  const file = await openOpfsFile(dbFilename)
  return file ? file.size : null
}

const safeScan = async (dbFilename: string): Promise<OpfsPageScanResult | { error: string } | null> => {
  try {
    const file = await openOpfsFile(dbFilename)
    if (!file) return null
    return await scanForZeroPages(file)
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

const safeStorageEstimate = async (): Promise<{ usage?: number; quota?: number } | { error: string }> => {
  try {
    if (typeof navigator.storage?.estimate !== 'function') return { error: 'estimate unavailable' }
    const { usage, quota } = await navigator.storage.estimate()
    return { usage, quota }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

const safeOpfsInventory = async (
  dbFilename: string,
): Promise<OpfsInventoryEntry[] | { error: string }> => {
  try {
    const root = await navigator.storage.getDirectory()
    const wanted = new Set<string>([dbFilename, ...DB_FILE_SIBLING_SUFFIXES.map(s => dbFilename + s)])
    const entries: OpfsInventoryEntry[] = []
    let ahpPools = 0
    let otherFiles = 0
    for await (const [name, handle] of iterateEntries(root)) {
      if (name.startsWith('.ahp-')) {
        ahpPools++
        continue
      }
      if (!wanted.has(name)) {
        otherFiles++
        continue
      }
      let size: number | null = null
      if (handle.kind === 'file') {
        try {
          size = (await (handle as FileSystemFileHandle).getFile()).size
        } catch {
          size = null
        }
      }
      entries.push({ name, kind: handle.kind, size })
    }
    // Record aggregate counts of everything else without listing (avoids PII /
    // unbounded output) — just enough to spot stale access-handle pools.
    entries.push({ name: `(.ahp-* pools)`, kind: 'directory', size: ahpPools })
    entries.push({ name: `(other entries)`, kind: 'directory', size: otherFiles })
    return entries
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

// `FileSystemDirectoryHandle.entries()` isn't in the TS lib DOM types yet.
const iterateEntries = (
  root: FileSystemDirectoryHandle,
): AsyncIterable<[string, FileSystemHandle]> =>
  (root as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()
