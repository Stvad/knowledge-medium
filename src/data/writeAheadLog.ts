/**
 * Keeping `OPFSWriteAheadVFS`'s log bounded during a bulk write, and small after it.
 *
 * The VFS cannot checkpoint past a read that is still in flight, so every commit
 * after that read's snapshot stays in the log as a full copy of each page it
 * dirtied. A bulk writer racing a long read grows the log by gigabytes, and the
 * next page load re-reads all of it before the app can open (#1341).
 *
 * A bulk writer runs inside {@link runBulkWrite}, which drains the log however
 * the write ends, and calls {@link awaitWriteAheadHeadroom} between its batches.
 * Both run on the WRITER connection — PowerSync's `execute` and `writeLock` —
 * because the log size and the checkpoint are per connection, and only the
 * writer's describe the log it is growing. Under `OPFSCoopSyncVFS` there is no
 * log and SQLite answers these pragmas itself: the headroom check never pauses,
 * and the drain costs two tiny writes.
 */
import { CallbackSet } from '@/utils/callbackSet'

interface WriteAheadDb {
  execute(sql: string): Promise<unknown>
}

/** PowerSync's `writeLock`: one lease on the writer connection, which other
 *  tabs' writers wait for too. */
export interface WriteLockDb {
  writeLock<T>(fn: (tx: WriteAheadDb) => Promise<T>): Promise<T>
}

/** `db` as a {@link WriteLockDb}. PowerSync's database has `writeLock`, but
 *  `PowerSyncDb` does not declare it. */
export const asWriteLockDb = (db: unknown): WriteLockDb => {
  if (typeof (db as Partial<WriteLockDb> | null)?.writeLock !== 'function') {
    throw new Error('PowerSync database does not expose writeLock')
  }
  return db as WriteLockDb
}

/** Log size at which a bulk writer stops and waits for a checkpoint, which
 *  bounds what the next page load has to re-read at a few seconds. Up to about
 *  twice this can stay on disk: a checkpoint leaves the active file's bytes in
 *  place until the writer next swaps files. */
export const WRITE_AHEAD_HEADROOM_BYTES = 256 * 1024 * 1024

/** Each logged page carries a frame header. */
const FRAME_HEADER_BYTES = 32

/** The first cell of a statement's answer, as a finite number, or null. */
const firstCellNumber = (result: unknown): number | null => {
  const rows = (result as {rows?: {_array?: unknown[]}} | undefined)?.rows?._array
  const row = Array.isArray(rows) ? rows[0] : undefined
  if (!row || typeof row !== 'object') return null
  const [value] = Object.values(row as Record<string, unknown>)
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/** The pages a `PRAGMA wal_checkpoint` answer reports outstanding, or null when
 *  it has no readable first cell.
 *
 *  Positional because the VFSes answer differently, yet zero means "nothing
 *  outstanding" under both: `OPFSWriteAheadVFS` returns one cell, named and
 *  valued as its approximate count of un-checkpointed pages, while SQLite
 *  answers its own pragma with `busy, log, checkpointed`. */
export const checkpointResultPages = firstCellNumber

export interface WriteAheadPause {
  /** Approximate size of the log the writer stopped at. */
  readonly logBytes: number
}

const pauseListeners = new CallbackSet<[WriteAheadPause | null]>('write-ahead-pause')
/** Checks waiting in a checkpoint right now. Each takes the writer on its own,
 *  so two bulk writers can both be waiting. */
let pausedChecks = 0

/** Hear when a bulk writer stops to let the log drain (`pause`, once per writer
 *  that stops), and when writing resumes (`null`, once the last of them is done).
 *
 *  The pause holds the writer connection, so every write on this device waits —
 *  not just the bulk writer's. So do the reads of the tab whose read is holding
 *  the log: PowerSync sends a read to whichever connection comes free first, and
 *  that tab's only reader is the one still busy. */
export const onWriteAheadPause = (listener: (pause: WriteAheadPause | null) => void): () => void =>
  pauseListeners.add(listener)

/** The status line for a pause, shared by every bulk writer that shows one. */
const describeWriteAheadPause = ({logBytes}: WriteAheadPause): string =>
  `Paused until a long-running read of the database finishes: writing on would grow its log of ` +
  `pending changes past ${Math.round(logBytes / (1024 * 1024))} MB. This continues by itself.`

/** Fixed for a database's life, so read once per connection object. */
const pageSizes = new WeakMap<WriteAheadDb, number>()

const pageSizeOf = async (db: WriteAheadDb): Promise<number | null> => {
  const known = pageSizes.get(db)
  if (known !== undefined) return known
  const size = firstCellNumber(await db.execute('PRAGMA page_size'))
  if (size !== null) pageSizes.set(db, size)
  return size
}

/**
 * Between two batches of a bulk write: if the log has passed `limitBytes`, wait
 * in a truncate checkpoint until it is folded into the main file.
 *
 * The checkpoint waits for every read in flight, which is the point — the
 * writer stops here instead of growing the log while the read keeps it. That
 * wait is as long as the longest such read, and has no bound of its own: a read
 * that never ends stalls this writer, where without the pause it would have
 * filled the disk instead.
 *
 * A failed checkpoint only warns. The log stays as large as it would have been
 * without this call, which is no reason to abort the write it was protecting.
 */
export const awaitWriteAheadHeadroom = async (
  db: WriteAheadDb,
  limitBytes: number = WRITE_AHEAD_HEADROOM_BYTES,
): Promise<void> => {
  const pages = checkpointResultPages(await db.execute('PRAGMA wal_checkpoint=noop')) ?? 0
  if (pages === 0) return
  const pageSize = await pageSizeOf(db)
  if (pageSize === null) return
  const logBytes = pages * (pageSize + FRAME_HEADER_BYTES)
  if (logBytes < limitBytes) return
  const pausedAt = performance.now()
  console.info(`[writeAheadLog] pausing bulk writes: the log is ~${Math.round(logBytes / 1048576)} MB`)
  pausedChecks += 1
  pauseListeners.notify({logBytes})
  try {
    await db.execute('PRAGMA wal_checkpoint=truncate')
  } catch (error) {
    console.warn('[writeAheadLog] the checkpoint to bound the log failed; writing on:', error)
  } finally {
    console.info(`[writeAheadLog] resuming after ${Math.round(performance.now() - pausedAt)} ms`)
    pausedChecks -= 1
    if (pausedChecks === 0) pauseListeners.notify(null)
  }
}

/** The VFS swaps log files once this many pages are un-checkpointed. 1 makes the
 *  next write swap, since every write leaves at least page 1 in the log. */
const SWAP_ON_NEXT_WRITE = 1
/** What hands both the VFS and SQLite back their defaults (1000 pages; no limit). */
const DEFAULT_JOURNAL_SIZE_LIMIT = -1
/** A key in a local-only table every booted database has, written only to make
 *  the writer swap files. */
const DRAIN_MARKER_KEY = 'write_ahead_drain'

/**
 * After a bulk write: leave both log files small, so the next page load has
 * nothing to re-read. Prefer {@link runBulkWrite}, which calls this on every
 * ending.
 *
 * One truncate checkpoint is not enough. It copies every page into the main
 * file but truncates only the INACTIVE log file; the active one keeps its bytes
 * until the writer swaps away from it, and the next open re-reads all of them.
 * The writer swaps only on a write that finds the inactive file empty and the
 * log at `journal_size_limit` pages. So: checkpoint (inactive file now empty),
 * make a swap due on the next write, write twice (the first leaves pages in the
 * log, the second swaps), and checkpoint again, which truncates the file the
 * writer just left.
 *
 * All under one lease on the writer: another connection's checkpoint between
 * the two writes would empty the log the first one left, and the second would
 * then not swap. Waits out any read in flight, twice, like
 * {@link awaitWriteAheadHeadroom}.
 */
export const drainWriteAheadLog = (db: WriteLockDb): Promise<void> => db.writeLock(async tx => {
  await tx.execute('PRAGMA wal_checkpoint=truncate')
  await tx.execute(`PRAGMA journal_size_limit=${SWAP_ON_NEXT_WRITE}`)
  try {
    await tx.execute(
      `INSERT OR REPLACE INTO client_schema_state (key, completed_at) VALUES ('${DRAIN_MARKER_KEY}', 0)`)
    await tx.execute(`DELETE FROM client_schema_state WHERE key = '${DRAIN_MARKER_KEY}'`)
  } finally {
    await tx.execute(`PRAGMA journal_size_limit=${DEFAULT_JOURNAL_SIZE_LIMIT}`)
  }
  await tx.execute('PRAGMA wal_checkpoint=truncate')
})

const DRAINING_STATUS = 'Writing pending changes into the database file…'

/**
 * Run a bulk write with both halves of the log's upkeep around it, and the
 * status lines for them: `say` gets a line when a pause starts and when the
 * drain starts — both can wait out a read — and `null` when writing resumes,
 * which means "show your own status again". The log is drained when the write
 * ends, however it ends, since a write that throws after some batches committed
 * leaves as much log behind as one that finished. `write` still calls
 * {@link awaitWriteAheadHeadroom} between its batches.
 *
 * Neither the drain nor `say` can change the write's outcome: each failure only
 * warns, and so does a `db` with no `writeLock` to drain through.
 */
export const runBulkWrite = async <T,>(
  db: unknown,
  say: (line: string | null) => void,
  write: () => Promise<T>,
): Promise<T> => {
  const stopReporting = onWriteAheadPause(pause => say(pause && describeWriteAheadPause(pause)))
  try {
    return await write()
  } finally {
    stopReporting()
    try {
      say(DRAINING_STATUS)
    } catch (error) {
      console.warn('[writeAheadLog] a bulk write\'s status line threw:', error)
    }
    try {
      await drainWriteAheadLog(asWriteLockDb(db))
    } catch (error) {
      console.warn('[writeAheadLog] draining the log after a bulk write failed:', error)
    }
  }
}
