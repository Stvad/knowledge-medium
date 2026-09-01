/**
 * Every file SQLite or the VFS derives from the main `.db` name.
 *
 * Its own module, with NO imports, because the service worker's stale-preview
 * sweep needs it too and is built without the `@/` alias and without the app's
 * module graph. A suffix missing from any one consumer is a file that survives
 * that consumer's cleanup and then replays over the next database at that name
 * — which is how a third, silently diverging copy of this list caused the
 * write-ahead sidecars to be left behind by the preview sweep.
 */

/** `OPFSWriteAheadVFS`'s write-ahead log — two files, alternated WAL2-style. */
export const WRITE_AHEAD_SIDECAR_SUFFIXES = ['-wa0', '-wa1'] as const

export const DB_FILE_SIBLING_SUFFIXES = [
  '-journal',
  '-wal',
  '-shm',
  ...WRITE_AHEAD_SIDECAR_SUFFIXES,
] as const
