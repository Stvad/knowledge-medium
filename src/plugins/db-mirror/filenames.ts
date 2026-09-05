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
 * TWO SEPARATE GROUPS follow it, not one hash of both, and keeping them apart
 * is what makes ownership decidable:
 *
 *   - the INSTALL id, verbatim. It is minted on the first persisting write and
 *     lives outside the database, so it is known whenever a run can happen at
 *     all. Every copy this install writes therefore carries a group this
 *     install recognises — there is no state in which a copy of ours is
 *     unownable, and so no state in which one is immortal.
 *   - the DATABASE incarnation, hashed. It separates the database this install
 *     holds now from one it replaced, which is what stops the copies taken
 *     after a browser wipe from evicting the copies that hold what the wipe
 *     took. Unlike the install id it CAN be unknown — the log it derives from
 *     may be empty or unreadable — and {@link UNKNOWN_INCARNATION} stands in
 *     for that, so a degraded-state copy is still recognisably ours.
 *
 * A single combined tag could not express that split: an unknown half poisoned
 * the whole tag, so the run could neither prune nor be pruned.
 *
 * The final group is unique per RUN, which is what lets a failed run delete its
 * own entry without having to prove anything — no other run holds a name
 * carrying this run's token.
 */
import {fnv1a32Hex} from '@/utils/fnv1a.js'

/** `2026-09-04T13-45-02Z` — ISO 8601 UTC with the colons filesystems dislike
 *  swapped for dashes. */
const mirrorTimestamp = (at: number): string =>
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

/** Stands in for the database identity when the log it derives from cannot be
 *  read. A copy taken in that state is still tagged with the install that wrote
 *  it, so it stays prunable by its owner and by nobody else. */
export const UNKNOWN_INCARNATION = 'unknown'

/** The full 32 bits, zero-padded. Truncating it was saving two characters at
 *  the cost of 8 bits of collision resistance, and a collision here means one
 *  install's copies parse as another's. */
export const incarnationTagOf = (incarnation: string): string =>
  fnv1a32Hex(incarnation).padStart(8, '0')

const baseOf = (dbFilename: string): string => dbFilename.replace(/\.db$/, '')

/** Everything after the database's own base name. Anchored at both ends and
 *  matched against the REMAINDER of the name, so the database base needs no
 *  regex escaping — it is compared with `startsWith`, not interpolated. */
const SUFFIX =
  /^-mirror-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)-([0-9a-f]{8})-([0-9a-f]{8})-[0-9a-f]{6}\.db$/

/** The name a copy taken by `installId`, holding `incarnation`, at `at` gets.
 *  `token` defaults to a fresh random one and exists so tests can pin a name. */
export const dbMirrorFilename = (
  dbFilename: string,
  installId: string,
  incarnation: string,
  at: number,
  token: string = randomToken(),
): string =>
  `${baseOf(dbFilename)}-mirror-${mirrorTimestamp(at)}-${installId}-${incarnationTagOf(incarnation)}-${token}.db`

export interface MirrorCopyName {
  /** The instant in the name. */
  at: number
  /** Which install wrote it — compare against your own to decide ownership. */
  installId: string
  /** The HASHED incarnation, which is what the name carries. Compare against
   *  {@link incarnationTagOf} of the identity you hold, never against the
   *  identity itself. */
  incarnation: string
}

/** What `name` says about itself, or undefined when this feature did not write
 *  it. Deliberately reports the install rather than filtering on it: the caller
 *  needs to tell "not mine, leave it alone" from "mine, from a database I
 *  replaced" from "mine, current" — and only the caller knows which it is. */
export const parseDbMirrorFilename = (
  dbFilename: string,
  name: string,
): MirrorCopyName | undefined => {
  const base = baseOf(dbFilename)
  if (!name.startsWith(base)) return undefined
  const match = SUFFIX.exec(name.slice(base.length))
  if (!match) return undefined
  const at = parseMirrorTimestamp(match[1])
  return at === undefined ? undefined : {at, installId: match[2], incarnation: match[3]}
}
