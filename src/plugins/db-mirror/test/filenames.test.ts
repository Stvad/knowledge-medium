import {describe, expect, it} from 'vitest'
import {
  dbMirrorFilename,
  isDbMirrorFilename,
  parseDbMirrorFilename,
} from '../filenames.js'

const DB = 'kmp-v6-alice.db'
const AT = Date.UTC(2026, 8, 4, 13, 45, 2)

describe('dbMirrorFilename', () => {
  it('names a copy after the database it came from plus a sortable timestamp', () => {
    expect(dbMirrorFilename(DB, AT)).toBe('kmp-v6-alice-mirror-2026-09-04T13-45-02Z.db')
  })

  it('round-trips through the parser', () => {
    expect(parseDbMirrorFilename(DB, dbMirrorFilename(DB, AT))).toBe(AT)
  })

  it('sorts lexicographically in the same order as chronologically', () => {
    const earlier = dbMirrorFilename(DB, AT)
    const later = dbMirrorFilename(DB, AT + 60_000)
    expect([later, earlier].sort()).toEqual([earlier, later])
  })
})

describe('isDbMirrorFilename', () => {
  it('accepts what this feature writes', () => {
    expect(isDbMirrorFilename(DB, dbMirrorFilename(DB, AT))).toBe(true)
  })

  it.each([
    ['the live database itself', 'kmp-v6-alice.db'],
    ['a write-ahead sidecar', 'kmp-v6-alice.db-wa0'],
    ['a manual export', 'kmp-v6-alice-export-1757000000000.db'],
    ['a recovery archive', 'kmp-v6-alice-recovery-1757000000000.zip'],
    ['another user’s mirror', 'kmp-v6-bob-mirror-2026-09-04T13-45-02Z.db'],
    ['an unrelated file the user keeps in the folder', 'taxes-2026.db'],
    ['a similar name with a different timestamp shape', 'kmp-v6-alice-mirror-nightly.db'],
    ['a name that merely starts like one', 'kmp-v6-alice-mirror-2026-09-04T13-45-02Z.db.bak'],
  ])('rejects %s', (_label, name) => {
    expect(isDbMirrorFilename(DB, name)).toBe(false)
  })

  it('is not fooled by a database name containing regex metacharacters', () => {
    // Preview deploys namespace the filename with `~`; nothing in a sanitized
    // user id is regex-special today, but the pattern must not depend on that.
    const db = 'kmp-v6-~pr-9~a.b.db'
    expect(isDbMirrorFilename(db, dbMirrorFilename(db, AT))).toBe(true)
    expect(isDbMirrorFilename(db, 'kmp-v6-XprX9Xa.b-mirror-2026-09-04T13-45-02Z.db')).toBe(false)
  })
})
