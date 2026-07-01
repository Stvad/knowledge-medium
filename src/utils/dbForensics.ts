/**
 * Out-of-band forensic breadcrumbs for local-DB corruption.
 *
 * The recurring iPad OPFS corruptions (issue #284, [[ipad-opfs-corruption-1gib-page]])
 * give us a clear END STATE but no record of the SEQUENCE that produced it, so
 * we can't discriminate the candidate mechanisms (non-durable flush on process
 * kill vs a WebKit-OPFS boundary bug vs a coop-lock/handle issue). This module
 * records the breadcrumbs that would tell them apart, and auto-captures a full
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
const SCANLOG_KEY = 'scanlog'
const UNCLEAN_PREFIX = 'unclean:'
const SNAPSHOT_PREFIX = 'snapshot:'

const MAX_SESSION_EVENTS = 24
const MAX_SCANLOG = 20
const MAX_UNCLEAN_ARCHIVES = 20
const MAX_SNAPSHOTS = 10

const DB_FILE_SIBLING_SUFFIXES = ['-journal', '-wal', '-shm'] as const

export interface ForensicSessionRecord {
  startedAt: number
  lastSeenAt: number
  cleanShutdown: boolean
  userId: string
  userAgent: string
  dbSizeAtStart: number | null
  events: Array<{ t: number; type: string }>
}

export interface ScanLogEntry {
  at: number
  dbSize: number | null
  pageCount: number
  zeroPageCount: number
  firstZeroPageByteOffset: number | null
  elapsedMs: number
  timedOut: boolean
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

  private get<T>(key: string): Promise<T | undefined> {
    return this.store.tx('readonly', s => s.get(key) as IDBRequest<T | undefined>)
  }

  private async put(key: string, value: unknown): Promise<void> {
    await this.store.tx('readwrite', s => s.put(value, key))
  }

  /**
   * Open a new session and detect whether the PREVIOUS one ended uncleanly (the
   * process was killed before `markCleanShutdown` ran — the process-kill
   * fingerprint). Returns whether the last session was unclean plus the running
   * count. Best-effort: on any failure returns a benign default.
   */
  async recordSessionStart(opts: { userId: string; dbFilename: string }): Promise<{
    uncleanShutdown: boolean
    uncleanShutdownCount: number
  }> {
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
  }

  /** Mark the current session as ended cleanly. Call on `pagehide`. */
  async markCleanShutdown(): Promise<void> {
    try {
      const current = await this.get<ForensicSessionRecord>(CURRENT_SESSION_KEY)
      if (!current) return
      current.cleanShutdown = true
      current.lastSeenAt = Date.now()
      current.events = appendCapped(current.events, { t: current.lastSeenAt, type: 'clean-shutdown' })
      await this.put(CURRENT_SESSION_KEY, current)
    } catch (err) {
      warn('markCleanShutdown failed', err)
    }
  }

  /** Append a lifecycle breadcrumb (visibilitychange / freeze / resume …). */
  async recordLifecycleEvent(type: string): Promise<void> {
    try {
      const current = await this.get<ForensicSessionRecord>(CURRENT_SESSION_KEY)
      if (!current) return
      const now = Date.now()
      current.lastSeenAt = now
      current.events = appendCapped(current.events, { t: now, type })
      await this.put(CURRENT_SESSION_KEY, current)
    } catch (err) {
      warn('recordLifecycleEvent failed', err)
    }
  }

  /**
   * Zero-page scan the OPFS `.db`, append a size/scan sample to the log, and —
   * if a zeroed page is found — auto-capture a full corruption snapshot. Cheap
   * (~3s over 1.4 GB); run on idle. Returns the scan result (or null on failure).
   */
  async logScan(opts: { userId: string; dbFilename: string }): Promise<OpfsPageScanResult | null> {
    let scan: OpfsPageScanResult | null = null
    try {
      const file = await openOpfsFile(opts.dbFilename)
      if (!file) return null
      scan = await scanForZeroPages(file)
      const entry: ScanLogEntry = {
        at: Date.now(),
        dbSize: scan.fileSize,
        pageCount: scan.pageCount,
        zeroPageCount: scan.zeroPageCount,
        firstZeroPageByteOffset: scan.firstZeroPageByteOffset,
        elapsedMs: scan.elapsedMs,
        timedOut: scan.timedOut,
      }
      const log = (await this.get<ScanLogEntry[]>(SCANLOG_KEY)) ?? []
      await this.put(SCANLOG_KEY, appendCapped(log, entry, MAX_SCANLOG))
    } catch (err) {
      warn('logScan failed', err)
      return scan
    }
    if (scan && scan.zeroPageCount > 0) {
      await this.captureCorruptionSnapshot({
        userId: opts.userId,
        dbFilename: opts.dbFilename,
        reason: 'startup-scan-zero-page',
        scan,
      })
    }
    return scan
  }

  /**
   * Gather and persist a full forensic snapshot: OPFS inventory + sizes, storage
   * estimate, a zero-page scan (reused if the caller already ran one), the
   * current session + unclean-shutdown count, and any caller-supplied DB-side
   * context. Call this on `SQLITE_CORRUPT` detection BEFORE any recovery.
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
      const snapshot: CorruptionSnapshot = {
        at: Date.now(),
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
      await this.put(`${SNAPSHOT_PREFIX}${snapshot.at}`, snapshot)
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

  /** Keep only the newest `keep` records under `prefix` (keys are `<prefix><ts>`). */
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

const tsOf = (key: string, prefix: string): number => Number(key.slice(prefix.length)) || 0

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
