/*
 * Naming for the mirrored database copies.
 *
 * ONE definition serves both the writer and the pruner: the pruner deletes
 * exactly what {@link dbMirrorFilename} produces and nothing else, so the two
 * cannot drift into "prune removed a file the mirror never wrote". The user's
 * database filename is part of the pattern, so two accounts (or a PR preview
 * and production) mirroring into the same folder each prune only their own.
 *
 * The timestamp is a `:`-free ISO form — legal on every filesystem, readable in
 * a file browser, and lexicographically ordered the same as chronologically, so
 * "keep the newest N" is a sort over names.
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
  return Number.isNaN(at) ? undefined : at
}

const baseOf = (dbFilename: string): string => dbFilename.replace(/\.db$/, '')

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const patternFor = (dbFilename: string): RegExp =>
  new RegExp(`^${escapeRegExp(baseOf(dbFilename))}-mirror-(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}Z)\\.db$`)

/** The name a mirror copy taken at `at` gets. */
export const dbMirrorFilename = (dbFilename: string, at: number): string =>
  `${baseOf(dbFilename)}-mirror-${mirrorTimestamp(at)}.db`

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
