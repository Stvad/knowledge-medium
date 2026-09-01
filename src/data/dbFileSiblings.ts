/**
 * Every file SQLite or the VFS derives from the main `.db` name. A suffix
 * missing from any consumer of this list is a file that survives that
 * consumer's cleanup and then replays over the next database of that name.
 *
 * Its own module, with NO imports, so the service worker's stale-preview sweep
 * can share it: that build has no path alias and must not pull in the app's
 * module graph.
 */

/** `OPFSWriteAheadVFS`'s write-ahead log — two files, alternated WAL2-style. */
export const WRITE_AHEAD_SIDECAR_SUFFIXES = ['-wa0', '-wa1'] as const

/**
 * SQLite's own crash-recovery files. These must be removed BEFORE the main
 * `.db`: left beside a fresh database of the same name, SQLite replays them.
 */
export const SQLITE_JOURNAL_SUFFIXES = ['-journal', '-wal', '-shm'] as const

/** Everything derived from the main `.db` name, for inventory and backup. */
export const DB_FILE_SIBLING_SUFFIXES = [
  ...SQLITE_JOURNAL_SUFFIXES,
  ...WRITE_AHEAD_SIDECAR_SUFFIXES,
] as const
