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
 * The random token after it makes the name unique per RUN, which is what lets
 * a failed run delete its own entry without having to prove ownership — no
 * other run can be holding a name that carries this run's token.
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

const baseOf = (dbFilename: string): string => dbFilename.replace(/\.db$/, '')

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const patternFor = (dbFilename: string): RegExp =>
  new RegExp(
    `^${escapeRegExp(baseOf(dbFilename))}-mirror-` +
    '(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}Z)-([0-9a-f]{6})\\.db$',
  )

/** The name a mirror copy taken at `at` gets. `token` defaults to a fresh
 *  random one and exists so tests can pin a name. */
export const dbMirrorFilename = (
  dbFilename: string,
  at: number,
  token: string = randomToken(),
): string => `${baseOf(dbFilename)}-mirror-${mirrorTimestamp(at)}-${token}.db`

/** When `name` is one of this feature's own copies, the instant it was taken. */
export const parseDbMirrorFilename = (
  dbFilename: string,
  name: string,
): number | undefined => {
  const match = patternFor(dbFilename).exec(name)
  return match ? parseMirrorTimestamp(match[1]) : undefined
}

export const isDbMirrorFilename = (dbFilename: string, name: string): boolean =>
  parseDbMirrorFilename(dbFilename, name) !== undefined
