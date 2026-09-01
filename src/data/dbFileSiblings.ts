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

export const DB_FILE_SIBLING_SUFFIXES = [
  '-journal',
  '-wal',
  '-shm',
  ...WRITE_AHEAD_SIDECAR_SUFFIXES,
] as const
