/**
 * One mirror run: copy this device's SQLite database into the user's folder,
 * then prune the copies the feature itself has written.
 *
 * The copy goes through `exportRawSqliteDbToFile`, which holds PowerSync's
 * write lock and checkpoints the write-ahead sidecars into the main file first,
 * so what lands on disk is a complete `.db` and no sidecars need to travel
 * with it.
 *
 * WHY EACH RUN WRITES A NEW UNIQUELY NAMED FILE, rather than a temp file
 * renamed over a fixed one: an interrupted run must leave the previous copy
 * intact, and a run that never opens the previous copy cannot damage it. The
 * remaining hazard is the run's OWN entry — `getFileHandle(…, {create: true})`
 * creates it empty, well before any bytes arrive — so a failure removes it, and
 * the pruner discards any zero-length copy a hard crash left behind. The run
 * token in the name is what makes both of those provably the run's own entry.
 * (Rename would be `FileSystemFileHandle.move()`, which is not a standardised
 * method; the bytes themselves are already committed atomically, since a
 * writable stream only updates the entry when it CLOSES.)
 *
 * Runs do not overlap — `schedule.ts` holds a cross-tab lock — which is what
 * lets the pruner read an empty copy as crash residue rather than as another
 * run's destination that has not been filled yet.
 */
import type {Repo} from '@/data/repo'
import {dbFilenameForUser} from '@/data/localDbStorage.js'
import {exportRawSqliteDbToFile} from '@/utils/exportSqliteDb.js'
import {readChangeMarker} from './changeMarker.js'
import {dbMirrorFilename, parseDbMirrorFilename} from './filenames.js'
import {queryDirectoryPermission} from './fileSystemAccess.js'

export type DbMirrorOutcome =
  | {
      kind: 'mirrored'
      filename: string
      bytes: number
      /** Stored as the next run's `lastMarker`; undefined when unreadable. */
      marker: string | undefined
      pruned: readonly string[]
    }
  | {kind: 'skipped-unchanged'; marker: string; pruned: readonly string[]}
  | {kind: 'permission-lost'; permission: PermissionState}

export interface DbMirrorRunOptions {
  repo: Repo
  directory: FileSystemDirectoryHandle
  /** How many copies survive, counting the one this run writes. */
  keepCount: number
  now: number
  /** The marker recorded by the last successful run, if any. */
  lastMarker?: string
  /** Per-run token in the copy's name; defaults to a fresh random one. Pinned
   *  by tests so they can state the expected filename rather than reading it
   *  back from the run, which would assert nothing about the naming. */
  token?: string
  /** Seams for tests; production uses the real checkpointed export. */
  exportToFile?: (
    repo: Repo,
    handle: FileSystemFileHandle,
  ) => Promise<{filename: string; size: number}>
  readMarker?: (repo: Repo) => Promise<string | undefined>
}

const removeQuietly = async (
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<boolean> => {
  try {
    await directory.removeEntry(name)
    return true
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotFoundError') return false
    console.warn(`[db-mirror] could not remove ${name}`, err)
    return false
  }
}

/**
 * Delete the copies this feature wrote that are no longer wanted, and NOTHING
 * else: every candidate has to parse as one of {@link dbMirrorFilename}'s names
 * for this user's database, so another account's mirrors, manual exports,
 * recovery archives and the user's own files in the folder are all invisible
 * here.
 *
 * `protectedName` is the copy the calling run just wrote. It is kept whatever
 * the timestamps say and takes one of the keep slots: ordering by the stamp in
 * the name is only as good as the clock that wrote it, and a clock that jumped
 * backwards — or copies left by one that ran fast — would otherwise rank the
 * new copy last and delete it, while the run still reported success and stored
 * its marker, so later runs would skip with nothing on disk to show for it.
 *
 * Zero-length copies go first and unconditionally — a complete mirror is never
 * empty, so an empty one is the entry a crashed run created and never filled,
 * and letting it occupy a keep slot would push out a copy that has real bytes.
 */
export const pruneDbMirrorCopies = async (
  directory: FileSystemDirectoryHandle,
  dbFilename: string,
  keepCount: number,
  protectedName?: string,
): Promise<readonly string[]> => {
  const copies: Array<{name: string; at: number; empty: boolean}> = []
  for await (const entry of directory.values()) {
    if (entry.kind !== 'file') continue
    if (entry.name === protectedName) continue
    const at = parseDbMirrorFilename(dbFilename, entry.name)
    if (at === undefined) continue
    copies.push({name: entry.name, at, empty: (await entry.getFile()).size === 0})
  }

  // The protected copy occupies one of the slots, so only the rest compete.
  const keep = Math.max(0, Math.max(1, Math.trunc(keepCount)) - (protectedName ? 1 : 0))
  const doomed = [
    ...copies.filter(copy => copy.empty),
    ...copies
      .filter(copy => !copy.empty)
      .sort((a, b) => b.at - a.at || b.name.localeCompare(a.name))
      .slice(keep),
  ]

  const removed: string[] = []
  for (const copy of doomed) {
    if (await removeQuietly(directory, copy.name)) removed.push(copy.name)
  }
  return removed
}

/** Pruning never fails a run: the copy is on disk and good, and failing over
 *  housekeeping would discard that. The next run retries the same files. */
const prune = async (
  directory: FileSystemDirectoryHandle,
  dbFilename: string,
  keepCount: number,
  protectedName?: string,
): Promise<readonly string[]> => {
  try {
    return await pruneDbMirrorCopies(directory, dbFilename, keepCount, protectedName)
  } catch (err) {
    console.warn('[db-mirror] could not prune older copies', err)
    return []
  }
}

export const runDbMirror = async ({
  repo,
  directory,
  keepCount,
  now,
  lastMarker,
  token,
  exportToFile = exportRawSqliteDbToFile,
  readMarker = readChangeMarker,
}: DbMirrorRunOptions): Promise<DbMirrorOutcome> => {
  // Queried, never requested: a prompt outside a user gesture is denied by the
  // browser, so asking here would burn the one chance the settings surface has.
  const permission = await queryDirectoryPermission(directory)
  if (permission !== 'granted') return {kind: 'permission-lost', permission}

  // Read BEFORE the copy. A write landing between this reading and the export's
  // lock makes the copy NEWER than the marker it is stored under, which costs
  // one redundant run later; reading after would store a marker for changes the
  // copy might not contain, and that direction loses data.
  const marker = await readMarker(repo)
  const dbFilename = dbFilenameForUser(repo.user.id)
  // Housekeeping is about the FOLDER, not about the copy, so it also runs on
  // the skipped path: otherwise lowering the keep count never takes effect
  // while the database sits unchanged, and a pruning failure is never retried.
  if (marker !== undefined && marker === lastMarker) {
    return {kind: 'skipped-unchanged', marker, pruned: await prune(directory, dbFilename, keepCount)}
  }

  const filename = dbMirrorFilename(dbFilename, now, token)
  const handle = await directory.getFileHandle(filename, {create: true})

  let bytes: number
  try {
    const {size} = await exportToFile(repo, handle)
    const written = (await handle.getFile()).size
    if (written !== size) {
      throw new Error(
        `The mirrored copy is the wrong size — ${written} bytes on disk against ${size} expected. ` +
        'The copy was discarded; earlier copies are untouched.',
      )
    }
    bytes = size
  } catch (err) {
    // Ours to clean up: the entry exists because this run created it.
    await removeQuietly(directory, filename)
    throw err
  }

  return {
    kind: 'mirrored',
    filename,
    bytes,
    marker,
    pruned: await prune(directory, dbFilename, keepCount, filename),
  }
}
