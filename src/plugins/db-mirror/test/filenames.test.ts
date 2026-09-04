import {describe, expect, it} from 'vitest'
import {
  dbMirrorFilename,
  incarnationTag,
  isDbMirrorFilename,
  parseDbMirrorFilename,
} from '../filenames.js'

const DB = 'kmp-v6-alice.db'
const AT = Date.UTC(2026, 8, 4, 13, 45, 2)
/** Identity of the database whose copies these are. */
const DB1 = '1700000000000'
const DB2 = '1700000000001'
const TAG = incarnationTag(DB1)

describe('dbMirrorFilename', () => {
  it('names a copy after the database it came from plus a sortable timestamp', () => {
    expect(dbMirrorFilename(DB, DB1, AT, 'abc123')).toBe(
      `kmp-v6-alice-mirror-2026-09-04T13-45-02Z-${TAG}-abc123.db`,
    )
  })

  it('round-trips through the parser', () => {
    expect(parseDbMirrorFilename(DB, DB1, dbMirrorFilename(DB, DB1, AT))).toBe(AT)
  })

  it('sorts lexicographically in the same order as chronologically', () => {
    const earlier = dbMirrorFilename(DB, DB1, AT, 'aaaaaa')
    const later = dbMirrorFilename(DB, DB1, AT + 60_000, 'aaaaaa')
    expect([later, earlier].sort()).toEqual([earlier, later])
  })

  it('gives two runs in the same second different names', () => {
    // The name is what makes a failed run's cleanup provably its own entry:
    // no other run can be holding a name carrying this run's token.
    const names = new Set(Array.from({length: 200}, () => dbMirrorFilename(DB, DB1, AT)))
    expect(names.size).toBe(200)
  })
})

describe('isDbMirrorFilename', () => {
  it('accepts what this feature writes', () => {
    expect(isDbMirrorFilename(DB, DB1, dbMirrorFilename(DB, DB1, AT))).toBe(true)
  })

  it.each([
    ['the live database itself', 'kmp-v6-alice.db'],
    ['a write-ahead sidecar', 'kmp-v6-alice.db-wa0'],
    ['a manual export', 'kmp-v6-alice-export-1757000000000.db'],
    ['a recovery archive', 'kmp-v6-alice-recovery-1757000000000.zip'],
    ['another user’s mirror', `kmp-v6-bob-mirror-2026-09-04T13-45-02Z-${TAG}-abc123.db`],
    ['an unrelated file the user keeps in the folder', 'taxes-2026.db'],
    ['a similar name with a different timestamp shape', 'kmp-v6-alice-mirror-nightly.db'],
    ['a name that merely starts like one', `kmp-v6-alice-mirror-2026-09-04T13-45-02Z-${TAG}-abc123.db.bak`],
    ['one with no run token', `kmp-v6-alice-mirror-2026-09-04T13-45-02Z-${TAG}.db`],
    // `Date.parse` turns this into March 3rd rather than rejecting it, so
    // without the round-trip check the pruner would adopt a file it never wrote.
    ['a calendar-invalid date the writer could never produce', `kmp-v6-alice-mirror-2026-02-31T13-45-02Z-${TAG}-abc123.db`],
    ['an impossible hour', `kmp-v6-alice-mirror-2026-09-04T25-45-02Z-${TAG}-abc123.db`],
  ])('rejects %s', (_label, name) => {
    expect(isDbMirrorFilename(DB, DB1, name)).toBe(false)
  })

  it('does not claim a copy another database wrote', () => {
    // A folder shared between two devices, or holding copies from before the
    // browser wiped the local store, contains copies this database must never
    // prune. Ownership is a property of the FILE, not of a side table.
    const theirs = dbMirrorFilename(DB, DB2, AT, 'abc123')
    expect(isDbMirrorFilename(DB, DB1, theirs)).toBe(false)
    expect(isDbMirrorFilename(DB, DB2, theirs)).toBe(true)
  })

  it('is not fooled by a database name containing regex metacharacters', () => {
    // Preview deploys namespace the filename with `~`; nothing in a sanitized
    // user id is regex-special today, but the pattern must not depend on that.
    const db = 'kmp-v6-~pr-9~a.b.db'
    expect(isDbMirrorFilename(db, DB1, dbMirrorFilename(db, DB1, AT))).toBe(true)
    expect(
      isDbMirrorFilename(db, DB1, `kmp-v6-XprX9Xa.b-mirror-2026-09-04T13-45-02Z-${TAG}-abc123.db`),
    ).toBe(false)
  })
})
