import {describe, expect, it} from 'vitest'
import {
  dbMirrorFilename,
  incarnationTagOf,
  parseDbMirrorFilename,
} from '../filenames.js'
import {fnv1a32Hex} from '@/utils/fnv1a.js'

const DB = 'kmp-v6-alice.db'
const AT = Date.UTC(2026, 8, 4, 13, 45, 2)
/** Two installs, and two databases one of them held in turn. */
const INSTALL_A = 'a1b2c3d4'
const INSTALL_B = 'e5f6a7b8'
const BEFORE = '1700000000000'
const AFTER = '1799000000000'
const TAG = incarnationTagOf(BEFORE)

/** What the parser says about a name, or undefined when it did not write it. */
const parse = (name: string) => parseDbMirrorFilename(DB, name)
const mine = (name: string) => parse(name)?.installId === INSTALL_A

describe('dbMirrorFilename', () => {
  it('names a copy after the database, a sortable timestamp, its install and its incarnation', () => {
    expect(dbMirrorFilename(DB, INSTALL_A, BEFORE, AT, 'abc123')).toBe(
      `kmp-v6-alice-mirror-2026-09-04T13-45-02Z-${INSTALL_A}-${TAG}-abc123.db`,
    )
  })

  it('round-trips through the parser', () => {
    expect(parse(dbMirrorFilename(DB, INSTALL_A, BEFORE, AT))).toEqual({
      at: AT,
      installId: INSTALL_A,
      incarnation: TAG,
    })
  })

  it('sorts lexicographically in the same order as chronologically', () => {
    const earlier = dbMirrorFilename(DB, INSTALL_A, BEFORE, AT, 'aaaaaa')
    const later = dbMirrorFilename(DB, INSTALL_A, BEFORE, AT + 60_000, 'aaaaaa')
    expect([later, earlier].sort()).toEqual([earlier, later])
  })

  it('gives two runs in the same second different names', () => {
    // The name is what makes a failed run's cleanup provably its own entry:
    // no other run can be holding a name carrying this run's token.
    const names = new Set(Array.from({length: 200}, () => dbMirrorFilename(DB, INSTALL_A, BEFORE, AT)))
    expect(names.size).toBe(200)
  })
})

describe('the two identity groups', () => {
  it('separates two installs holding the same database', () => {
    // Restoring a mirror onto a second machine copies the database wholesale,
    // incarnation and all — so only the locally minted install id can tell the
    // two machines apart, and it is what keeps each off the other's copies.
    const theirs = dbMirrorFilename(DB, INSTALL_B, BEFORE, AT, 'abc123')
    expect(parse(theirs)).toMatchObject({installId: INSTALL_B, incarnation: TAG})
    expect(mine(theirs)).toBe(false)
  })

  it('separates two databases one install held in turn', () => {
    // The axis this whole feature turns on: after the browser wipes the local
    // store the app rebuilds a DIFFERENT database, and the copies holding what
    // the wipe took must not look like copies of the new one.
    const beforeTheLoss = dbMirrorFilename(DB, INSTALL_A, BEFORE, AT, 'abc123')
    const afterTheLoss = dbMirrorFilename(DB, INSTALL_A, AFTER, AT, 'abc123')
    expect(beforeTheLoss).not.toBe(afterTheLoss)
    expect(mine(beforeTheLoss) && mine(afterTheLoss)).toBe(true)
    expect(parse(beforeTheLoss)?.incarnation).not.toBe(parse(afterTheLoss)?.incarnation)
  })
})

describe('parseDbMirrorFilename', () => {
  it.each([
    ['the live database itself', 'kmp-v6-alice.db'],
    ['a write-ahead sidecar', 'kmp-v6-alice.db-wa0'],
    ['a manual export', 'kmp-v6-alice-export-1757000000000.db'],
    ['a recovery archive', 'kmp-v6-alice-recovery-1757000000000.zip'],
    ['another user’s mirror', `kmp-v6-bob-mirror-2026-09-04T13-45-02Z-${INSTALL_A}-${TAG}-abc123.db`],
    ['an unrelated file the user keeps in the folder', 'taxes-2026.db'],
    ['a similar name with a different timestamp shape', 'kmp-v6-alice-mirror-nightly.db'],
    ['a name that merely starts like one', `kmp-v6-alice-mirror-2026-09-04T13-45-02Z-${INSTALL_A}-${TAG}-abc123.db.bak`],
    ['one with no run token', `kmp-v6-alice-mirror-2026-09-04T13-45-02Z-${INSTALL_A}-${TAG}.db`],
    ['one with no incarnation group', `kmp-v6-alice-mirror-2026-09-04T13-45-02Z-${INSTALL_A}-abc123.db`],
    ['a group that is not hex', `kmp-v6-alice-mirror-2026-09-04T13-45-02Z-zzzzzzzz-${TAG}-abc123.db`],
    // `Date.parse` turns this into March 3rd rather than rejecting it, so
    // without the round-trip check the pruner would adopt a file it never wrote.
    ['a calendar-invalid date the writer could never produce', `kmp-v6-alice-mirror-2026-02-31T13-45-02Z-${INSTALL_A}-${TAG}-abc123.db`],
    ['an impossible hour', `kmp-v6-alice-mirror-2026-09-04T25-45-02Z-${INSTALL_A}-${TAG}-abc123.db`],
  ])('rejects %s', (_label, name) => {
    expect(parse(name)).toBeUndefined()
  })

  it('is not fooled by a database name containing regex metacharacters', () => {
    // Preview deploys namespace the filename with `~`; nothing in a sanitized
    // user id is regex-special today, and the pattern no longer interpolates
    // the base at all, but a neighbouring database must still not match.
    const db = 'kmp-v6-~pr-9~a.b.db'
    expect(parseDbMirrorFilename(db, dbMirrorFilename(db, INSTALL_A, BEFORE, AT))).toBeDefined()
    expect(
      parseDbMirrorFilename(db, `kmp-v6-XprX9Xa.b-mirror-2026-09-04T13-45-02Z-${INSTALL_A}-${TAG}-abc123.db`),
    ).toBeUndefined()
  })

  it('parses an incarnation whose hash is shorter than the group', () => {
    // FNV-1a hex drops leading zeroes, so roughly one incarnation in sixteen
    // hashes to fewer than eight characters. Without the zero-pad those copies
    // do not match the group pattern at all — so the install that wrote them
    // would stop recognising them, and nothing would ever prune them.
    const short = '68'
    expect(fnv1a32Hex(short).length).toBeLessThan(8)
    expect(incarnationTagOf(short)).toHaveLength(8)
    const name = dbMirrorFilename(DB, INSTALL_A, short, AT)
    expect(parse(name)).toMatchObject({installId: INSTALL_A, incarnation: incarnationTagOf(short)})
  })

  it('does not mistake a longer database name for this one', () => {
    // `alice2`'s copies start with `alice`'s base, and the anchor after it is
    // the only thing keeping one account's pruner off the other's files.
    expect(parse(dbMirrorFilename('kmp-v6-alice2.db', INSTALL_A, BEFORE, AT))).toBeUndefined()
  })
})
