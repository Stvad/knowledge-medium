/**
 * Keeping `OPFSWriteAheadVFS`'s log bounded during a bulk write, and small after it.
 *
 * The VFS cannot checkpoint past a read that is still in flight, so every commit
 * after that read's snapshot stays in the log as a full copy of each page it
 * dirtied. A bulk writer racing a long read grows the log by gigabytes, and the
 * next page load re-reads all of it before the app can open (#1341).
 *
 * Bulk writers call {@link awaitWriteAheadHeadroom} between batches and
 * {@link drainWriteAheadLog} once they finish. Both take PowerSync's `execute`,
 * which runs on the WRITER connection: the log size and the checkpoint are per
 * connection, and only the writer's describe the log it is growing. Under
 * `OPFSCoopSyncVFS` there is no log, SQLite answers these pragmas itself, and
 * both are no-ops.
 */
import { CallbackSet } from '@/utils/callbackSet'

interface WriteAheadDb {
  execute(sql: string): Promise<unknown>
}

/** Log size at which a bulk writer stops and waits for a checkpoint. Re-reading
 *  a log costs the next page load about 7 ms per MB, so this bounds that at a
 *  couple of seconds — and the disk the log takes at a few hundred MB. */
export const WRITE_AHEAD_HEADROOM_BYTES = 256 * 1024 * 1024

/** Each logged page carries a frame header. */
const FRAME_HEADER_BYTES = 32

/** The first cell of a `PRAGMA wal_checkpoint` answer, as a number — or null
 *  when the answer has no readable first cell.
 *
 *  Positional because the VFSes answer differently, yet zero means "nothing
 *  outstanding" under both: `OPFSWriteAheadVFS` returns one cell, named and
 *  valued as its approximate count of un-checkpointed pages, while SQLite
 *  answers its own pragma with `busy, log, checkpointed`. */
export const checkpointResultPages = (result: unknown): number | null => {
  const rows = (result as {rows?: {_array?: unknown[]}} | undefined)?.rows?._array
  const row = Array.isArray(rows) ? rows[0] : undefined
  if (!row || typeof row !== 'object') return null
  const [value] = Object.values(row as Record<string, unknown>)
  const pages = Number(value)
  return Number.isFinite(pages) ? pages : null
}

export interface WriteAheadPause {
  /** Approximate size of the log the writer stopped at. */
  readonly logBytes: number
}

const pauseListeners = new CallbackSet<[WriteAheadPause | null]>('write-ahead-pause')

/** Hear when a bulk writer stops to let the log drain (`pause`), and when it
 *  resumes (`null`). The writer is the database's only one, so while a pause
 *  lasts every write on this device waits, not just the bulk writer's. */
export const onWriteAheadPause = (listener: (pause: WriteAheadPause | null) => void): () => void =>
  pauseListeners.add(listener)

/** The status line for a pause, shared by every bulk writer that shows one. */
export const describeWriteAheadPause = ({logBytes}: WriteAheadPause): string =>
  `Paused until a long-running read of the database finishes: writing on would grow its log of ` +
  `pending changes past ${Math.round(logBytes / (1024 * 1024))} MB. This continues by itself.`

const pageSizeOf = async (db: WriteAheadDb): Promise<number> => {
  const result = await db.execute('PRAGMA page_size')
  const [size] = Object.values((result as {rows: {_array: Record<string, unknown>[]}}).rows._array[0]!)
  return Number(size)
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
  const logBytes = pages * (await pageSizeOf(db) + FRAME_HEADER_BYTES)
  if (logBytes < limitBytes) return
  const pausedAt = performance.now()
  console.info(`[writeAheadLog] pausing bulk writes: the log is ~${Math.round(logBytes / 1048576)} MB`)
  pauseListeners.notify({logBytes})
  try {
    await db.execute('PRAGMA wal_checkpoint=truncate')
  } catch (error) {
    console.warn('[writeAheadLog] the checkpoint to bound the log failed; writing on:', error)
  } finally {
    console.info(`[writeAheadLog] resuming after ${Math.round(performance.now() - pausedAt)} ms`)
    pauseListeners.notify(null)
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
 * nothing to re-read.
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
 * Waits out any read in flight, twice, like {@link awaitWriteAheadHeadroom}.
 */
export const drainWriteAheadLog = async (db: WriteAheadDb): Promise<void> => {
  await db.execute('PRAGMA wal_checkpoint=truncate')
  await db.execute(`PRAGMA journal_size_limit=${SWAP_ON_NEXT_WRITE}`)
  try {
    await db.execute(
      `INSERT OR REPLACE INTO client_schema_state (key, completed_at) VALUES ('${DRAIN_MARKER_KEY}', 0)`)
    await db.execute(`DELETE FROM client_schema_state WHERE key = '${DRAIN_MARKER_KEY}'`)
  } finally {
    await db.execute(`PRAGMA journal_size_limit=${DEFAULT_JOURNAL_SIZE_LIMIT}`)
  }
  await db.execute('PRAGMA wal_checkpoint=truncate')
}
