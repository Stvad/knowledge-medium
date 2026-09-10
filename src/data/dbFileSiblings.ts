/*
 * Every file SQLite or the VFS derives from the main `.db` name.
 *
 * Read this before merging the two lists back together. Inventory and backup
 * want all of them, but the DELETING paths must not treat them alike, and the
 * two halves need OPPOSITE orders:
 *
 *  - `SQLITE_JOURNAL_SUFFIXES` go BEFORE the main file. Left beside a fresh
 *    database of the same name, SQLite replays them onto it.
 *  - `WRITE_AHEAD_SIDECAR_SUFFIXES` go AFTER it, best-effort — deleting a log
 *    while its `.db` survives strips committed frames from a database the
 *    caller is then told was left intact. A log that outlives its database is
 *    harmless instead: `OPFSWriteAheadVFS` truncates both sidecars when it
 *    opens a `.db` that does not exist.
 *
 * Import is the exception that proves it: it writes a new `.db` afterwards, so
 * everything must be gone first, and the old database goes first of all.
 *
 * Its own module, with NO imports, so the service worker's stale-preview sweep
 * can share it: that build has no path alias and must not pull in the app's
 * module graph.
 */

/** `OPFSWriteAheadVFS`'s write-ahead log — two files, alternated WAL2-style. */
export const WRITE_AHEAD_SIDECAR_SUFFIXES = ['-wa0', '-wa1'] as const

/** SQLite's rollback journal — the only journal mode this app's VFSes write. */
export const SQLITE_ROLLBACK_JOURNAL_SUFFIX = '-journal'

/**
 * SQLite's own crash-recovery files. These must be removed BEFORE the main
 * `.db`: left beside a fresh database of the same name, SQLite replays them.
 *
 * Wider than what this app produces, deliberately: deletion should clear
 * anything SQLite could replay, whoever wrote it. Restoring is the opposite and
 * uses a narrower whitelist — see `exportSqliteDb`.
 */
export const SQLITE_JOURNAL_SUFFIXES = [SQLITE_ROLLBACK_JOURNAL_SUFFIX, '-wal', '-shm'] as const

/** Everything derived from the main `.db` name, for inventory and backup. */
export const DB_FILE_SIBLING_SUFFIXES = [
  ...SQLITE_JOURNAL_SUFFIXES,
  ...WRITE_AHEAD_SIDECAR_SUFFIXES,
] as const
