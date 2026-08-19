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

const MAX_SESSION_EVENTS = 24
const MAX_UNCLEAN_ARCHIVES = 20
const MAX_SNAPSHOTS = 10

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
        return { uncleanShutdown, uncleanShutdownCount: meta.uncleanShutdownCount }
      } catch (err) {
        warn('recordSessionStart failed', err)
        return { uncleanShutdown: false, uncleanShutdownCount: 0 }
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
