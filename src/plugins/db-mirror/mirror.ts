/**
 * One mirror run: copy this device's SQLite database into the user's folder,
 * then prune the copies this install has written for the database in front of
 * it.
 *
 * The copy goes through `exportRawSqliteDbToFile`, which holds PowerSync's
 * write lock and checkpoints the write-ahead sidecars into the main file first,
 * so what lands on disk is a complete `.db` and no sidecars need to travel
 * with it.
 *
 * WHY EACH RUN WRITES A NEW UNIQUELY NAMED FILE, rather than a temp file
 * renamed over a fixed one: an interrupted run must leave the previous copy
 * intact, and a run that never opens the previous copy cannot damage it. The
 * remaining hazard is the run's OWN entry, which a failure removes — so the run
 * claims a name that did not exist a moment ago rather than trusting
 * `{create: true}`, which adopts an existing file silently. The pruner discards
 * any too-small copy a hard crash left behind.
 * (Rename would be `FileSystemFileHandle.move()`, which is not a standardised
 * method; the bytes themselves are already committed atomically, since a
 * writable stream only updates the entry when it CLOSES.)
 *
 * Runs do not overlap — `schedule.ts` holds a cross-tab lock — which is what
 * lets the pruner read a stub copy as crash residue rather than as another
 * run's destination that has not been filled yet.
 */
import type {Repo} from '@/data/repo'
import {dbFilenameForUser} from '@/data/localDbStorage.js'
import {exportRawSqliteDbToFile} from '@/utils/exportSqliteDb.js'
import {readChangeMarker} from './changeMarker.js'
import {dbMirrorFilename, incarnationTagOf, parseDbMirrorFilename} from './filenames.js'
import {queryDirectoryPermission} from './fileSystemAccess.js'

/** What the export's deadline should say when it is a BACKGROUND copy that ran
 *  out of time. The interactive export's message tells the user to close the
 *  other tabs and reload, which is the wrong advice for the cause a scheduled
 *  copy actually hits: a destination too slow to finish inside the window a
 *  background job may hold the database. The deadline itself is deliberately
 *  not extended — a copy that freezes the app for longer is worse, not better. */
const COPY_TIMEOUT_MESSAGE =
  'Copying the database into the chosen folder did not finish within the time a background copy ' +
  'may hold the database, so nothing was written and earlier copies are untouched. A folder on a ' +
  'slow or cloud-synced drive is the usual cause; one on this device\'s own disk will be faster. ' +
  'If the app itself now feels stuck, another tab is holding the database — reload to free it.'

/** A SQLite file begins with a 100-byte header. Anything shorter cannot be a
 *  database whatever else it is, so it is residue from a run that died between
 *  claiming the name and writing the bytes. This does NOT catch a copy
 *  truncated part-way through — only `lastBytes`, which the skip checks,
 *  covers that, and only for the most recent copy. */
const SQLITE_HEADER_BYTES = 100

export type DbMirrorOutcome =
  | {
      kind: 'mirrored'
      filename: string
      bytes: number
      /** Stored as part of the next run's `lastCopy`; undefined when unreadable. */
      marker: string | undefined
      pruned: readonly string[]
      unmanaged: number
    }
  | {kind: 'skipped-unchanged'; marker: string; pruned: readonly string[]; unmanaged: number}
  | {kind: 'permission-lost'; permission: PermissionState}

export interface DbMirrorRunOptions {
  repo: Repo
  directory: FileSystemDirectoryHandle
  /** How many copies survive, counting the one this run writes. */
  keepCount: number
  now: number
  /** This install. Always known when a run can happen: it is minted by the same
   *  persisting write that records the opt-in. */
  installId: string
  /** Which database this is. REQUIRED, and there is deliberately no stand-in
   *  for "could not tell": see `governedBy`. A caller that cannot establish one
   *  must not call this. */
  incarnation: string
  /** What the last successful run left behind, if anything. The marker and the
   *  filename travel TOGETHER because the skip needs both: the marker says the
   *  database has not moved, and only the file's presence in THIS folder says
   *  a copy of it is actually there. */
  lastCopy?: {marker: string; filename: string; bytes?: number}
  /** Per-run token in the copy's name; defaults to a fresh random one. Pinned
   *  by tests so they can state the expected filename rather than reading it
   *  back from the run, which would assert nothing about the naming. */
  token?: string
  /** Seam for tests; production uses the real checkpointed export. */
  exportToFile?: (
    repo: Repo,
    handle: FileSystemFileHandle,
  ) => Promise<{filename: string; size: number}>
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
  installId: string
  /** The hashed incarnation the name carries. */
  incarnation: string
  /** Undefined when the entry could not be read; see {@link measure}. */
  size?: number
}

/** Every copy this feature wrote for this user's database, whichever install or
 *  incarnation it came from, and NOTHING else: a name has to parse as one of
 *  {@link dbMirrorFilename}'s, so another account's mirrors, manual exports,
 *  recovery archives and the user's own files are all invisible to everything
 *  below. Which of these the run may DELETE is decided by {@link governedBy}. */
const scanMirrorCopies = async (
  directory: FileSystemDirectoryHandle,
  dbFilename: string,
): Promise<MirrorCopy[]> => {
  const copies: MirrorCopy[] = []
  for await (const entry of directory.values()) {
    if (entry.kind !== 'file') continue
    const parsed = parseDbMirrorFilename(dbFilename, entry.name)
    if (parsed === undefined) continue
    copies.push({name: entry.name, ...parsed, size: await measure(entry)})
  }
  return copies
}

/** Per ENTRY, not per scan: a single unreadable file — an offline cloud
 *  placeholder, an OS-level error — would otherwise abort the whole listing, and
 *  a run that sees no copies both writes another one and prunes nothing, so the
 *  folder grows without bound. Undefined means "cannot tell", which must never
 *  become "residue, delete it". */
const measure = async (entry: FileSystemFileHandle): Promise<number | undefined> => {
  try {
    return (await entry.getFile()).size
  } catch (err) {
    console.warn(`[db-mirror] could not read ${entry.name}`, err)
    return undefined
  }
}

/**
 * Which copies THIS run is allowed to delete: the ones this install wrote for
 * the database in front of it.
 *
 * Another install's copies are never governed — a folder shared between two
 * machines, or synced by a cloud client, holds copies that are the only backup
 * some other device has. Neither are our own copies of a database we replaced:
 * that is the pre-wipe history this whole feature exists to keep.
 *
 * There is deliberately no third case for a copy taken while the database could
 * not name itself. A stand-in incarnation was tried and is wrong: an absent
 * identity is not an identity, so two copies carrying the stand-in can hold two
 * different databases, and ranking them together deletes one believing it has
 * the other. A run with no incarnation writes nothing instead.
 */
const governedBy = (installId: string, currentTag: string) =>
  (copy: MirrorCopy): boolean =>
    copy.installId === installId && copy.incarnation === currentTag

/**
 * Delete the copies that are no longer wanted.
 *
 * `protectedName` is the copy the calling run just wrote, or the one the stored
 * marker refers to. It is kept whatever the timestamps say and takes one of the
 * keep slots: ordering by the stamp in the name is only as good as the clock
 * that wrote it, and a clock that jumped backwards — or copies left by one that
 * ran fast — would otherwise rank the new copy last and delete it, while the
 * run still reported success and stored its marker.
 *
 * Residue goes first and unconditionally — a complete mirror is never shorter
 * than a SQLite header, so a stub is the entry a crashed run created and never
 * filled (runs do not overlap; see the header), and letting it occupy a keep
 * slot would push out a copy that has real bytes.
 *
 * Never fails the run. DEFENCE IN DEPTH and unpinned — the only fallible step
 * is `removeQuietly`, which already catches everything — but the copy is on
 * disk and good by the time this runs, and discarding that over housekeeping
 * is not a trade worth leaving open to a future edit.
 */
const prune = async (
  directory: FileSystemDirectoryHandle,
  governed: readonly MirrorCopy[],
  keepCount: number,
  /** REQUIRED, not optional: every caller knows which copy is the current one,
   *  and an omitted argument silently reintroduces the clock-skew deletion this
   *  protects against. */
  protectedName: string | undefined,
): Promise<readonly string[]> => {
  const removed: string[] = []
  try {
    const copies = governed.filter(copy => copy.name !== protectedName)
    // The protected copy occupies one of the slots, so only the rest compete.
    // Non-finite inputs already land somewhere safe and need no separate clamp:
    // NaN falls through to `slice(0)`, which keeps the protected copy and
    // nothing else — the same as the minimum legal count — and Infinity keeps
    // everything. `normalizeSettings` makes both unreachable anyway.
    const keep = Math.max(0, Math.max(1, Math.trunc(keepCount)) - (protectedName ? 1 : 0))
    const doomed = [
      ...copies.filter(isResidue),
      ...copies
        .filter(copy => !isResidue(copy) && !isUnreadable(copy))
        // The tiebreak is determinism, not policy: two copies can share a
        // second, and enumeration order is not specified.
        .sort((a, b) => b.at - a.at || b.name.localeCompare(a.name))
        .slice(keep),
    ]
    for (const copy of doomed) {
      if (await removeQuietly(directory, copy.name)) removed.push(copy.name)
    }
  } catch (err) {
    console.warn('[db-mirror] could not prune older copies', err)
  }
  return removed
}

/** Residue from a run that died between claiming the name and writing the
 *  bytes. Not a truncation test — see {@link SQLITE_HEADER_BYTES}. */
const isResidue = (copy: MirrorCopy): boolean =>
  copy.size !== undefined && copy.size < SQLITE_HEADER_BYTES

/** An entry we could not open — an offline cloud placeholder, an OS-level read
 *  error. It is neither deleted (we cannot tell it is residue) nor counted
 *  against the keep budget (we cannot tell it is a backup). Counting it was the
 *  worse half: on a cloud folder the newest entries are the ones most likely to
 *  be cold, so they took every keep slot and the copies actually openable on
 *  this device were the ones pruned. */
const isUnreadable = (copy: MirrorCopy): boolean => copy.size === undefined

/** The copy `lastCopy` names, actually on disk and actually whole.
 *
 *  A size we could READ, because an unreadable entry — an offline cloud
 *  placeholder — is not evidence a usable copy is there, and accepting one
 *  would protect it while pruning the readable copies behind it. And the size
 *  it was written with, because an interrupted sync can truncate a copy to
 *  something plausible. Neither deleted nor believed. */
const isIntactCopy = (copy: MirrorCopy, expectedBytes: number | undefined): boolean =>
  copy.size !== undefined &&
  copy.size >= SQLITE_HEADER_BYTES &&
  (expectedBytes === undefined || copy.size === expectedBytes)

/** Best-effort listing: a folder that cannot be read is not a reason to skip
 *  the copy, so the caller proceeds with nothing found. */
const scanQuietly = async (
  directory: FileSystemDirectoryHandle,
  dbFilename: string,
): Promise<MirrorCopy[]> => {
  try {
    return await scanMirrorCopies(directory, dbFilename)
  } catch (err) {
    console.warn('[db-mirror] could not list the folder', err)
    return []
  }
}

/**
 * A handle for a name that did NOT already exist.
 *
 * `getFileHandle(…, {create: true})` adopts an existing file just as happily as
 * it creates one, and the failure path deletes the name it was given — so
 * without this probe a run that collided with an existing file would delete
 * that file on its way out. The `NotFoundError` from the non-creating call IS
 * the proof, and it is what the header's claim about the run's own entry rests
 * on.
 */
const claimFreshEntry = async (
  directory: FileSystemDirectoryHandle,
  filename: string,
): Promise<FileSystemFileHandle> => {
  try {
    await directory.getFileHandle(filename)
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotFoundError') {
      return directory.getFileHandle(filename, {create: true})
    }
    throw err
  }
  throw new Error(
    `A file named ${filename} is already in the folder, so this run has no name of its own to ` +
    'write. Nothing was changed; the next run picks a different name.',
  )
}

export const runDbMirror = async ({
  repo,
  directory,
  keepCount,
  now,
  installId,
  incarnation,
  lastCopy,
  token,
  exportToFile = (repo, handle) =>
    exportRawSqliteDbToFile(repo, handle, {timeoutMessage: COPY_TIMEOUT_MESSAGE}),
}: DbMirrorRunOptions): Promise<DbMirrorOutcome> => {
  // Queried, never requested: a prompt outside a user gesture is denied by the
  // browser, so asking here would burn the one chance the settings surface has.
  const permission = await queryDirectoryPermission(directory)
  if (permission !== 'granted') return {kind: 'permission-lost', permission}

  // Read BEFORE the copy. A write landing between this reading and the export's
  // lock makes the copy NEWER than the marker it is stored under, which costs
  // one redundant run later; reading after would store a marker for changes the
  // copy might not contain, and that direction loses data.
  const marker = await readChangeMarker(repo)
  const dbFilename = dbFilenameForUser(repo.user.id)
  const mine = governedBy(installId, incarnationTagOf(incarnation))
  const partition = (scanned: readonly MirrorCopy[]) => {
    const governed = scanned.filter(mine)
    return {
      governed,
      // Every reason the folder can hold more than `keepCount` says it should:
      // another install's copies, our own from a database we replaced, and ours
      // that this device cannot open. Reported rather than ignored, so the
      // number the user set and the number of files they see can be reconciled.
      unmanaged:
        scanned.filter(copy => !mine(copy)).length + governed.filter(isUnreadable).length,
    }
  }

  if (marker !== undefined && marker === lastCopy?.marker) {
    // An equal marker only says the DATABASE has not moved. What the run is
    // deciding is whether a copy of it is in THIS folder — so the copy has to
    // be there. Otherwise deleting the last mirror by hand, or changing folders
    // while a run was in flight, would leave a stored marker that skipped every
    // run for good while the status went on claiming success.
    const {governed, unmanaged} = partition(await scanQuietly(directory, dbFilename))
    const present = governed.some(
      copy => copy.name === lastCopy.filename && isIntactCopy(copy, lastCopy.bytes),
    )
    // Housekeeping is about the folder, not about the copy, so it runs here
    // too: otherwise lowering the keep count never takes effect while the
    // database sits unchanged, and a pruning failure is never retried.
    if (present) {
      return {
        kind: 'skipped-unchanged',
        marker,
        unmanaged,
        // The copy the marker points at is the current one here, and the same
        // clock skew that could delete a freshly written copy could delete this.
        pruned: await prune(directory, governed, keepCount, lastCopy.filename),
      }
    }
  }

  const filename = dbMirrorFilename(dbFilename, installId, incarnation, now, token)
  const handle = await claimFreshEntry(directory, filename)

  let bytes: number
  try {
    const {size} = await exportToFile(repo, handle)
    bytes = size
  } catch (err) {
    // Ours to clean up: `claimFreshEntry` proved the name was free.
    await removeQuietly(directory, filename)
    throw err
  }

  // Verified AFTER the cleanup boundary, and a failure to read the size back is
  // not a reason to delete: the bytes are committed, and a copy that exists but
  // could not be measured is worth more than no copy. Only a size we actually
  // read and that disagrees condemns it — the next run re-checks anyway, since
  // the stored byte count is part of the skip's presence test.
  const written = await measure(handle)
  if (written !== undefined && written !== bytes) {
    await removeQuietly(directory, filename)
    throw new Error(
      `The mirrored copy is the wrong size — ${written} bytes on disk against ${bytes} expected. ` +
      'The copy was discarded; earlier copies are untouched.',
    )
  }

  const {governed, unmanaged} = partition(await scanQuietly(directory, dbFilename))
  return {
    kind: 'mirrored',
    filename,
    bytes,
    marker,
    unmanaged,
    pruned: await prune(directory, governed, keepCount, filename),
  }
}
