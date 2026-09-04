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
 * Two short hex groups follow it. The first is the DATABASE the copy came from
 * (see `readDatabaseIncarnation`), and it is what makes ownership a property of
 * the file rather than of a side table: a folder shared between two devices, or
 * one holding copies from before the browser wiped the local store, contains
 * copies this database must never prune. The second is unique per RUN, which is
 * what lets a failed run delete its own entry without having to prove anything
 * — no other run can hold a name carrying this run's token.
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

/** Six hex characters standing for a database identity — short enough to read in
 *  a file listing, and it only has to tell APART the handful of databases whose
 *  copies can share one folder, not be globally unique. */
export const incarnationTag = (incarnation: string): string => {
  // FNV-1a, because this needs to be stable across sessions and devices, and a
  // random id would not survive a reload.
  let hash = 0x811c9dc5
  for (let i = 0; i < incarnation.length; i++) {
    hash ^= incarnation.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0').slice(0, 6)
}

const baseOf = (dbFilename: string): string => dbFilename.replace(/\.db$/, '')

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const patternFor = (dbFilename: string, incarnation: string): RegExp =>
  new RegExp(
    `^${escapeRegExp(baseOf(dbFilename))}-mirror-` +
    '(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}Z)-' +
    `${incarnationTag(incarnation)}-[0-9a-f]{6}\\.db$`,
  )

/** The name a mirror copy of `incarnation` taken at `at` gets. `token` defaults
 *  to a fresh random one and exists so tests can pin a name. */
export const dbMirrorFilename = (
  dbFilename: string,
  incarnation: string,
  at: number,
  token: string = randomToken(),
): string =>
  `${baseOf(dbFilename)}-mirror-${mirrorTimestamp(at)}-${incarnationTag(incarnation)}-${token}.db`

/** When `name` is a copy THIS database wrote, the instant it was taken. A copy
 *  from another device, or from the database this one replaced, does not parse
 *  — which is exactly what keeps the pruner off it. */
export const parseDbMirrorFilename = (
  dbFilename: string,
  incarnation: string,
  name: string,
): number | undefined => {
  const match = patternFor(dbFilename, incarnation).exec(name)
  return match ? parseMirrorTimestamp(match[1]) : undefined
}

export const isDbMirrorFilename = (
  dbFilename: string,
  incarnation: string,
  name: string,
): boolean => parseDbMirrorFilename(dbFilename, incarnation, name) !== undefined
