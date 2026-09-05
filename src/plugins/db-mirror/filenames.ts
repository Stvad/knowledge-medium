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
 *     took.
 *
 * A single combined tag over both could not express that split: an unknown half
 * poisoned the whole tag, so the run could neither prune nor be pruned. The
 * incarnation has one further form, {@link UNCLAIMABLE_INCARNATION}, for a copy
 * taken while the database could not be identified; `governedBy` in `mirror.ts`
 * owns the reason it exists.
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

/** The full 32 bits, ZERO-PADDED — FNV-1a hex drops leading zeroes, so about one
 *  incarnation in sixteen would otherwise be too short to match the group at all,
 *  and its copies would be unrecognisable to the install that wrote them. The
 *  full width also keeps a collision — which would make one database's copies
 *  parse as another's — at 2^-32 rather than 2^-24. */
export const incarnationTagOf = (incarnation: string): string =>
  fnv1a32Hex(incarnation).padStart(8, '0')

/** The incarnation group for a copy taken while the log could not be read.
 *  Deliberately OUTSIDE the hex alphabet, so {@link incarnationTagOf} can never
 *  produce it: such a copy parses to `incarnation: undefined`, which matches no
 *  current tag, so no run ever claims it. See `governedBy` in `mirror.ts` for
 *  why that is the wanted outcome. */
export const UNCLAIMABLE_INCARNATION = 'xxxxxxxx'

const baseOf = (dbFilename: string): string => dbFilename.replace(/\.db$/, '')

/** Everything after the database's own base name. Anchored at both ends and
 *  matched against the REMAINDER of the name, so the database base needs no
 *  regex escaping — it is compared with `startsWith`, not interpolated. */
const SUFFIX =
  /^-mirror-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)-([0-9a-f]{8})-([0-9a-f]{8}|xxxxxxxx)-[0-9a-f]{6}\.db$/

/** The group a copy's name carries for `incarnation` — the hash, or the
 *  unclaimable literal when the database could not be identified. The single
 *  place the two forms are decided, so the writer and the parser cannot
 *  disagree about which is which. */
export const incarnationGroup = (incarnation: string | undefined): string =>
  incarnation === undefined ? UNCLAIMABLE_INCARNATION : incarnationTagOf(incarnation)

/** The name a copy taken by `installId`, holding `incarnation`, at `at` gets.
 *  `token` defaults to a fresh random one and exists so tests can pin a name. */
export const dbMirrorFilename = (
  dbFilename: string,
  installId: string,
  incarnation: string | undefined,
  at: number,
  token: string = randomToken(),
): string =>
  `${baseOf(dbFilename)}-mirror-${mirrorTimestamp(at)}-${installId}-${incarnationGroup(incarnation)}-${token}.db`

/** The shape the install group must have to appear in a name at all. Exported
 *  so the mint and the parser cannot drift: an id outside it produces names
 *  this module will never match, which makes the copies unrecognisable to the
 *  very install that wrote them. */
export const INSTALL_ID_PATTERN = /^[0-9a-f]{8}$/

export interface MirrorCopyName {
  /** The instant in the name. */
  at: number
  /** Which install wrote it — compare against your own to decide ownership. */
  installId: string
  /** The HASHED incarnation the name carries. Compare against
   *  {@link incarnationTagOf} of the identity you hold, never against the
   *  identity itself. `undefined` for a copy taken while the database could not
   *  be identified, which therefore matches no current tag and is never
   *  pruned — see {@link UNCLAIMABLE_INCARNATION}. */
  incarnation: string | undefined
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
  if (at === undefined) return undefined
  const incarnation = match[3] === UNCLAIMABLE_INCARNATION ? undefined : match[3]
  return {at, installId: match[2], incarnation}
}
