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

/** Stands in when the copy's origin cannot be established. A constant, so
 *  copies taken in that state still share a namespace rather than scattering;
 *  pruning is skipped in that state regardless. */
const UNKNOWN_ORIGIN = 'unknown'

export type DbMirrorOutcome =
  | {
      kind: 'mirrored'
      filename: string
      bytes: number
      /** Stored as part of the next run's `lastCopy`; undefined when unreadable. */
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
  /** What the last successful run left behind, if anything. The marker and the
   *  filename travel TOGETHER because the skip needs both: the marker says the
   *  database has not moved, and only the file's presence in THIS folder says
   *  a copy of it is actually there. */
  lastCopy?: {marker: string; filename: string; bytes?: number}
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
  /** Where a copy this run writes comes from — this install holding this
   *  database. Undefined when either half is unknown, which forbids pruning. */
  origin?: string
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

interface MirrorCopy {
  name: string
  /** The instant in the name; see `filenames.ts` on why that is the ordering. */
  at: number
  empty: boolean
  /** Undefined when the entry could not be read; see {@link measure}. */
  size?: number
}

/** Every copy this feature wrote that is currently in the folder, and NOTHING
 *  else: a name has to parse as one of {@link dbMirrorFilename}'s for this
 *  user's database, so another account's mirrors, manual exports, recovery
 *  archives and the user's own files are all invisible to everything below. */
const scanMirrorCopies = async (
  directory: FileSystemDirectoryHandle,
  dbFilename: string,
  incarnation: string,
): Promise<MirrorCopy[]> => {
  const copies: MirrorCopy[] = []
  for await (const entry of directory.values()) {
    if (entry.kind !== 'file') continue
    const at = parseDbMirrorFilename(dbFilename, incarnation, entry.name)
    if (at === undefined) continue
    const size = await measure(entry)
    copies.push({name: entry.name, at, empty: size === 0, size})
  }
  return copies
}

/** Per ENTRY, not per scan: a single unreadable file — an offline cloud
 *  placeholder, an OS-level error — would otherwise abort the whole listing, and
 *  a run that sees no copies both writes another one and prunes nothing, so the
 *  folder grows without bound. Undefined means "cannot tell", which must never
 *  become "empty, delete it". */
const measure = async (entry: FileSystemFileHandle): Promise<number | undefined> => {
  try {
    return (await entry.getFile()).size
  } catch (err) {
    console.warn(`[db-mirror] could not read ${entry.name}`, err)
    return undefined
  }
}

/**
 * Delete the copies that are no longer wanted.
 *
 * `protectedName` is the copy the calling run just wrote. It is kept whatever
 * the timestamps say and takes one of the keep slots: ordering by the stamp in
 * the name is only as good as the clock that wrote it, and a clock that jumped
 * backwards — or copies left by one that ran fast — would otherwise rank the
 * new copy last and delete it, while the run still reported success and stored
 * its marker.
 *
 * Zero-length copies go first and unconditionally — a complete mirror is never
 * empty, so an empty one is the entry a crashed run created and never filled
 * (runs do not overlap; see the header), and letting it occupy a keep slot
 * would push out a copy that has real bytes.
 */
const pruneScanned = async (
  directory: FileSystemDirectoryHandle,
  scanned: readonly MirrorCopy[],
  keepCount: number,
  protectedName: string | undefined,
): Promise<readonly string[]> => {
  const copies = scanned.filter(copy => copy.name !== protectedName)
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
  scanned: readonly MirrorCopy[],
  keepCount: number,
  /** REQUIRED, not optional: every caller knows which copy is the current one —
   *  the one it just wrote, or the one the stored marker refers to — and an
   *  omitted argument silently reintroduces the clock-skew deletion this
   *  protects against. Pass `undefined` only when there genuinely is none. */
  protectedName: string | undefined,
): Promise<readonly string[]> => {
  try {
    return await pruneScanned(directory, scanned, keepCount, protectedName)
  } catch (err) {
    console.warn('[db-mirror] could not prune older copies', err)
    return []
  }
}

/** Best-effort listing: a folder that cannot be read is not a reason to skip
 *  the copy, so the caller proceeds with nothing found. */
const scanQuietly = async (
  directory: FileSystemDirectoryHandle,
  dbFilename: string,
  incarnation: string,
): Promise<MirrorCopy[]> => {
  try {
    return await scanMirrorCopies(directory, dbFilename, incarnation)
  } catch (err) {
    console.warn('[db-mirror] could not list the folder', err)
    return []
  }
}

export const runDbMirror = async ({
  repo,
  directory,
  keepCount,
  now,
  lastCopy,
  token,
  origin,
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
  // Nothing to establish where a copy came from, so nothing in the folder can
  // be proved to belong here. The run still copies — losing a backup is the
  // only unacceptable outcome — but nothing is pruned.
  const identity = origin ?? UNKNOWN_ORIGIN

  if (marker !== undefined && marker === lastCopy?.marker) {
    // An equal marker only says the DATABASE has not moved. What the run is
    // deciding is whether a copy of it is in THIS folder — so the copy has to
    // be there. Otherwise deleting the last mirror by hand, or changing folders
    // while a run was in flight, would leave a stored marker that skipped every
    // run for good while the status went on claiming success.
    const scanned = await scanQuietly(directory, dbFilename, identity)
    // Size, not merely non-empty: an interrupted cloud sync can truncate a copy
    // to something plausible, and calling that present would protect the
    // damaged file while pruning the intact older ones behind it.
    const present = scanned.some(
      copy =>
        copy.name === lastCopy.filename &&
        !copy.empty &&
        (lastCopy.bytes === undefined || copy.size === lastCopy.bytes),
    )
    // Housekeeping is about the folder, not about the copy, so it runs here
    // too: otherwise lowering the keep count never takes effect while the
    // database sits unchanged, and a pruning failure is never retried.
    if (present) {
      return {
        kind: 'skipped-unchanged',
        marker,
        // The copy the marker points at is the current one here, and the same
        // clock skew that could delete a freshly written copy could delete this.
        pruned: origin === undefined
          ? []
          : await prune(directory, scanned, keepCount, lastCopy.filename),
      }
    }
  }

  const filename = dbMirrorFilename(dbFilename, identity, now, token)
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
    pruned: origin === undefined
      ? []
      : await prune(
          directory,
          await scanQuietly(directory, dbFilename, identity),
          keepCount,
          filename,
        ),
  }
}
