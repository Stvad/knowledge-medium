/*
 * Naming for the mirrored database copies.
 *
 * ONE definition serves both the writer and the pruner: the pruner deletes
 * exactly what {@link dbMirrorFilename} produces and nothing else, so the two
 * cannot drift into "prune removed a file the mirror never wrote". The user's
 * database filename is part of the pattern, so two accounts — or a PR preview
 * and production, which get different database files — each prune only their
 * own copies.
 *
 * The timestamp is a `:`-free ISO form: legal on every filesystem, readable in
 * a file browser, and ordered the same lexicographically as chronologically.
 *
 * Two short hex groups follow it. The first is where the copy CAME FROM (see
 * {@link mirrorOrigin}), and it is what makes ownership a property of the file
 * rather than of a side table: a folder shared between two machines, or one
 * holding copies from before the browser wiped the local store, contains copies
 * this install must never prune. The second is unique per RUN, which is what
 * lets a failed run delete its own entry without having to prove anything — no
 * other run can hold a name carrying this run's token.
 */

/** `2026-09-04T13-45-02Z` — ISO 8601 UTC with the colons filesystems dislike
 *  swapped for dashes. */
export const mirrorTimestamp = (at: number): string =>
  new Date(at).toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-')

const parseMirrorTimestamp = (stamp: string): number | undefined => {
  const iso = stamp.replace(
    /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})Z$/,
    '$1:$2:$3Z',
  )
  if (iso === stamp) return undefined
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return undefined
  // `Date.parse` NORMALIZES a calendar-invalid date rather than rejecting it —
  // `2026-02-31T13:45:02Z` comes back as March 3rd — so a hand-typed name the
  // writer could never have produced would otherwise parse, and the pruner
  // would adopt somebody else's file. Round-tripping is the exact test:
  // accept a stamp only if formatting it back gives the same characters.
  return mirrorTimestamp(at) === stamp ? at : undefined
}

/** Per-run suffix; see the file header. Six hex characters, from the same CSPRNG
 *  as `randomUUID`, is far more than enough to separate runs that share a second. */
const randomToken = (): string =>
  crypto.randomUUID().replace(/-/g, '').slice(0, 6)

/**
 * Where a copy came from: this INSTALL, holding THIS database.
 *
 * Both halves are needed, and each covers what the other cannot. The install id
 * separates two machines — restoring a mirror onto a second device copies the
 * database wholesale, incarnation and all, so the database cannot identify the
 * machine. The incarnation separates two databases on one machine — an install
 * id survives in IndexedDB exactly when the browser wipes the local store, so
 * the install cannot identify the database.
 *
 * There is no third axis: a copy differs in origin from another only by coming
 * from a different machine or a different database on it.
 */
export const mirrorOrigin = (installId: string, incarnation: string): string =>
  `${installId}:${incarnation}`

/** Six hex characters standing for an origin — short enough to read in a file
 *  listing, and it only has to tell APART the handful of origins whose copies
 *  can share one folder, not be globally unique. */
export const originTag = (origin: string): string => {
  // FNV-1a, because this needs to be stable across sessions and devices, and a
  // random id would not survive a reload.
  let hash = 0x811c9dc5
  for (let i = 0; i < origin.length; i++) {
    hash ^= origin.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0').slice(0, 6)
}

const baseOf = (dbFilename: string): string => dbFilename.replace(/\.db$/, '')

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const patternFor = (dbFilename: string, origin: string): RegExp =>
  new RegExp(
    `^${escapeRegExp(baseOf(dbFilename))}-mirror-` +
    '(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}Z)-' +
    `${originTag(origin)}-[0-9a-f]{6}\\.db$`,
  )

/** The name a mirror copy from `origin` taken at `at` gets. `token` defaults
 *  to a fresh random one and exists so tests can pin a name. */
export const dbMirrorFilename = (
  dbFilename: string,
  origin: string,
  at: number,
  token: string = randomToken(),
): string =>
  `${baseOf(dbFilename)}-mirror-${mirrorTimestamp(at)}-${originTag(origin)}-${token}.db`

/** When `name` is a copy THIS origin wrote, the instant it was taken. A copy
 *  from another machine, or from the database this one replaced, does not parse
 *  — which is exactly what keeps the pruner off it. */
export const parseDbMirrorFilename = (
  dbFilename: string,
  origin: string,
  name: string,
): number | undefined => {
  const match = patternFor(dbFilename, origin).exec(name)
  return match ? parseMirrorTimestamp(match[1]) : undefined
}

export const isDbMirrorFilename = (
  dbFilename: string,
  origin: string,
  name: string,
): boolean => parseDbMirrorFilename(dbFilename, origin, name) !== undefined
