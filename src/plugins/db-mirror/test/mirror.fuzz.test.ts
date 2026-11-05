// @vitest-environment node
/**
 * Fuzz suite for the db-mirror naming and pruning — see `src/test/fuzz.ts` for
 * the smoke/deep tier mechanics.
 *
 * The mirror deletes files from a folder the user chose, so its oracles are
 * about WHICH files a run may touch, stated from the generator's own labels
 * (who wrote an entry, for which database, whether it reads) rather than by
 * parsing names the way the implementation does:
 *
 *  - naming: a copy's name parses back to the instant (to the second), the
 *    install and the incarnation group it was written with, and never parses
 *    for a database with a different filename — however the two filenames
 *    overlap.
 *  - pruning, over a random folder: nothing is removed that another install
 *    wrote, that a replaced or unidentified database wrote, that belongs to
 *    another database or to nothing, or that cannot be read; the copy the run
 *    protects survives; our own crash residue is removed; and of our own whole
 *    copies exactly `keepCount - 1` of the newest survive beside the protected
 *    one.
 */
import {describe, expect, it, vi} from 'vitest'
import fc from 'fast-check'
import type {Repo} from '@/data/repo'
import {dbFilenameForUser} from '@/data/localDbStorage.js'
import {fuzzParams, fuzzTestTimeout} from '@/test/fuzz'
import {dbMirrorFilename, incarnationTagOf, parseDbMirrorFilename} from '../filenames.js'
import {runDbMirror} from '../mirror.js'
import {FakeDirectoryHandle} from './fakeFileSystem.js'

const hexArb = (length: number) =>
  fc.string({unit: fc.constantFrom(...'0123456789abcdef'), minLength: length, maxLength: length})

/** 1970 through the last instant of year 9999 — the range a four-digit stamp holds. */
const atArb = fc.integer({min: 0, max: 253_402_300_799_999})

/** A database base name built from the pieces a copy's own name is made of, so
 *  one base can contain, prefix or extend another's copy names. */
const baseArb = fc
  .array(
    fc.oneof(
      {arbitrary: fc.constantFrom('kmp-v6-', 'alice', '-', '~', '.', 'db', '.db', '-mirror-', 'Z', '2026-09-04T13-45-02Z'), weight: 4},
      {arbitrary: hexArb(8), weight: 1},
      {arbitrary: fc.string({maxLength: 4}), weight: 1},
    ),
    {minLength: 1, maxLength: 6},
  )
  .map(parts => parts.join(''))

describe('mirror copy names', () => {
  it('parse back to what they were written with, and only for their own database', () => {
    fc.assert(
      fc.property(
        baseArb,
        baseArb,
        hexArb(8),
        fc.option(fc.string({maxLength: 20}), {nil: undefined}),
        atArb,
        hexArb(6),
        (base, otherBase, installId, incarnation, at, token) => {
          const db = `${base}.db`
          const name = dbMirrorFilename(db, installId, incarnation, at, token)
          expect(parseDbMirrorFilename(db, name)).toEqual({
            at: Math.floor(at / 1000) * 1000,
            installId,
            incarnation: incarnation === undefined ? undefined : incarnationTagOf(incarnation),
          })
          if (otherBase !== base) {
            expect(parseDbMirrorFilename(`${otherBase}.db`, name)).toBeUndefined()
          }
        },
      ),
      fuzzParams(300),
    )
  }, fuzzTestTimeout())

  it('accept a stamp only when it names a real instant, and report that instant', () => {
    // A name a pruner adopts must be one the writer could have produced: a
    // stamp `Date.parse` would normalize (`02-31` into March, hour 24 into the
    // next day) has to be refused, or the pruner claims a file it never wrote.
    const db = dbFilenameForUser('alice')
    const base = db.replace(/\.db$/, '')
    const two = (max: number) => fc.integer({min: 0, max}).map(n => String(n).padStart(2, '0'))
    fc.assert(
      fc.property(
        // Years from 1000: `Date.UTC` maps 0–99 into the 1900s, which would
        // make the oracle below wrong rather than the parser.
        fc.integer({min: 1000, max: 9999}), two(13), two(32), two(25), two(61), two(61),
        hexArb(8), fc.oneof(hexArb(8), fc.constant('xxxxxxxx')), hexArb(6),
        (year, month, day, hour, minute, second, installId, group, token) => {
          const stamp = `${year}-${month}-${day}T${hour}-${minute}-${second}Z`
          const name = `${base}-mirror-${stamp}-${installId}-${group}-${token}.db`
          const [mo, d, h, mi, s] = [month, day, hour, minute, second].map(Number)
          const daysInMonth = new Date(Date.UTC(year, mo, 0)).getUTCDate()
          const real = mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth && h <= 23 && mi <= 59 && s <= 59
          const parsed = parseDbMirrorFilename(db, name)
          if (!real) {
            expect(parsed).toBeUndefined()
            return
          }
          expect(parsed).toEqual({
            at: Date.UTC(year, mo - 1, d, h, mi, s),
            installId,
            incarnation: group === 'xxxxxxxx' ? undefined : group,
          })
        },
      ),
      fuzzParams(500),
    )
  }, fuzzTestTimeout())
})

// ──── Pruning over a random folder ────

const USER = 'alice'
const DB = dbFilenameForUser(USER)
const ME = 'a1b2c3d4'
const OTHER_INSTALL = 'e5f6a7b8'
const CURRENT = '1799000000000'
const REPLACED = '1700000000000'
const BASE_AT = Date.UTC(2026, 8, 4, 13, 45, 2)
const RUN_TOKEN = 'ffffff'
const COPY_BYTES = 1024
/** What `readChangeMarker` reads off {@link stubRepo}. */
const MARKER = '42/0.0/0.0'

const stubRepo = (): Repo =>
  ({
    user: {id: USER},
    db: {
      getAll: async (sql: string) => sql.includes('ps_crud') ? [{n: 0, last: null}] : [{marker: 42}],
    },
  } as unknown as Repo)

const fakeExport = async (_repo: Repo, handle: FileSystemFileHandle) => {
  const writable = await handle.createWritable()
  await new Blob([new Uint8Array(COPY_BYTES)]).stream().pipeTo(writable)
  return {filename: handle.name, size: COPY_BYTES}
}

type Writer = 'me' | 'other-install'
type Database = 'current' | 'replaced' | 'unidentified'

/** One entry in the folder, labelled with the truth the oracles read. */
interface EntrySpec {
  kind: 'copy' | 'stranger'
  name: string
  /** For a copy: who wrote it and for which database. */
  writer?: Writer
  database?: Database
  at?: number
  size: number
  unreadable: boolean
}

const strangerNameArb = fc.oneof(
  fc.constant(DB),
  fc.constant(`${DB}-wal`),
  fc.constant('notes.txt'),
  fc.constant('kmp-v6-alice-export-1757000000000.db'),
  // Another account's mirror: the same shape, a different database.
  fc.tuple(hexArb(8), hexArb(6), fc.integer({min: -50, max: 50})).map(([install, token, offset]) =>
    dbMirrorFilename(dbFilenameForUser('bob'), install, CURRENT, BASE_AT + offset * 60_000, token)),
)

/** Either crash residue (under a SQLite header) or a whole copy. */
const sizeArb = fc.oneof(fc.integer({min: 0, max: 99}), fc.constant(COPY_BYTES), fc.integer({min: 100, max: 4096}))

const entryArb: fc.Arbitrary<EntrySpec> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc
      .record({
        writer: fc.constantFrom<Writer>('me', 'me', 'other-install'),
        database: fc.constantFrom<Database>('current', 'current', 'replaced', 'unidentified'),
        // Whole seconds, both sides of the run's clock, with ties.
        offset: fc.integer({min: -20, max: 20}),
        token: hexArb(6).filter(token => token !== RUN_TOKEN),
        size: sizeArb,
        unreadable: fc.boolean(),
      })
      .map(({writer, database, offset, token, size, unreadable}): EntrySpec => {
        const at = BASE_AT + offset * 60_000
        const install = writer === 'me' ? ME : OTHER_INSTALL
        const incarnation = database === 'current' ? CURRENT : database === 'replaced' ? REPLACED : undefined
        return {kind: 'copy', name: dbMirrorFilename(DB, install, incarnation, at, token), writer, database, at, size, unreadable}
      }),
  },
  {
    weight: 1,
    arbitrary: fc.record({name: strangerNameArb, size: sizeArb, unreadable: fc.boolean()})
      .map((entry): EntrySpec => ({kind: 'stranger', ...entry})),
  },
)

const scenarioArb = fc.record({
  entries: fc.uniqueArray(entryArb, {selector: entry => entry.name, maxLength: 12}),
  keepCount: fc.integer({min: 1, max: 5}),
  /** The run's clock, which may sit behind every copy already there. */
  nowOffset: fc.integer({min: -25, max: 25}),
  identified: fc.constantFrom(true, true, true, false),
  /** What the last run recorded: nothing, or a marker and a filename that may
   *  or may not still be there, whole, and ours. Biased toward a matching
   *  marker on an entry in the folder, the only shape that can skip. */
  lastCopy: fc.option(
    fc.record({
      sameMarker: fc.constantFrom(true, true, true, false),
      target: fc.oneof(
        fc.constant({kind: 'missing' as const}),
        fc.record({kind: fc.constant('entry' as const), pick: fc.nat()}),
        // The previous run's own copy, added to the folder: whole, short, or unreadable.
        {weight: 3, arbitrary: fc.record({
          kind: fc.constant('previous' as const),
          size: fc.oneof({weight: 3, arbitrary: fc.constant(COPY_BYTES)}, {weight: 1, arbitrary: sizeArb}),
          unreadable: fc.constantFrom(false, false, false, true),
        })},
      ),
      bytes: fc.constantFrom<number | undefined>(undefined, COPY_BYTES, 777),
    }),
    {nil: undefined},
  ),
})

/** Ours to delete: written by this install for the database the run holds. */
const isGoverned = (entry: EntrySpec, identified: boolean): boolean =>
  identified && entry.kind === 'copy' && entry.writer === 'me' && entry.database === 'current'

describe('runDbMirror pruning', () => {
  it('only ever removes this install’s readable copies of the current database, keeping the newest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await fc.assert(
        fc.asyncProperty(scenarioArb, async ({entries: seeded, keepCount, nowOffset, identified, lastCopy}) => {
          const target = lastCopy?.target
          const previous: EntrySpec | undefined = target?.kind === 'previous' ? {
            kind: 'copy', writer: 'me', database: 'current', at: BASE_AT - 60_000,
            name: dbMirrorFilename(DB, ME, CURRENT, BASE_AT - 60_000, 'dddddd'),
            size: target.size, unreadable: target.unreadable,
          } : undefined
          const entries = previous && !seeded.some(entry => entry.name === previous.name) ? [...seeded, previous] : seeded
          const dir = new FakeDirectoryHandle()
          for (const entry of entries) {
            dir.seed(entry.name, entry.size)
            if (entry.unreadable) dir.unreadable.add(entry.name)
          }
          const recorded = lastCopy === undefined ? undefined : {
            marker: lastCopy.sameMarker ? MARKER : 'older-marker',
            filename: previous?.name
              ?? (target?.kind === 'entry' && entries.length > 0
                ? entries[target.pick % entries.length].name
                : dbMirrorFilename(DB, ME, CURRENT, BASE_AT - 3_600_000, 'eeeeee')),
            bytes: lastCopy.bytes,
          }
          const before = new Set(dir.names())

          const outcome = await runDbMirror({
            repo: stubRepo(),
            directory: dir.asHandle(),
            keepCount,
            now: BASE_AT + nowOffset * 60_000,
            installId: ME,
            incarnation: identified ? CURRENT : undefined,
            lastCopy: recorded,
            token: RUN_TOKEN,
            exportToFile: fakeExport,
          })
          if (outcome.kind === 'permission-lost') throw new Error('the fake folder is always granted')

          const byName = new Map(entries.map(entry => [entry.name, entry]))
          const removed = [...before].filter(name => !dir.entries.has(name))
          expect([...outcome.pruned].sort()).toEqual(removed.sort())

          // The copy the run vouches for: the one it wrote, or the recorded one
          // the skip found whole.
          let protectedName: string
          if (outcome.kind === 'mirrored') {
            protectedName = outcome.filename
            expect(dir.entries.get(outcome.filename)?.bytes.byteLength).toBe(COPY_BYTES)
          } else {
            const recordedEntry = recorded && byName.get(recorded.filename)
            expect(recorded?.marker).toBe(MARKER)
            expect(recordedEntry).toBeDefined()
            expect(isGoverned(recordedEntry!, identified)).toBe(true)
            expect(recordedEntry!.unreadable).toBe(false)
            expect(recordedEntry!.size).toBeGreaterThanOrEqual(100)
            if (recorded!.bytes !== undefined) expect(recordedEntry!.size).toBe(recorded!.bytes)
            protectedName = recorded!.filename
          }
          expect(dir.entries.has(protectedName)).toBe(true)

          for (const name of removed) {
            const entry = byName.get(name)!
            expect(isGoverned(entry, identified), `removed ${name}, which is not ours`).toBe(true)
            expect(entry.unreadable, `removed ${name}, which could not be read`).toBe(false)
          }

          const ours = entries.filter(entry => isGoverned(entry, identified) && !entry.unreadable && entry.name !== protectedName)
          for (const residue of ours.filter(entry => entry.size < 100)) {
            expect(removed, `kept residue ${residue.name}`).toContain(residue.name)
          }
          const whole = ours.filter(entry => entry.size >= 100)
          const kept = whole.filter(entry => dir.entries.has(entry.name))
          expect(kept).toHaveLength(Math.min(whole.length, keepCount - 1))
          for (const gone of whole.filter(entry => !dir.entries.has(entry.name))) {
            for (const survivor of kept) expect(gone.at!).toBeLessThanOrEqual(survivor.at!)
          }
        }),
        fuzzParams(200),
      )
    } finally {
      warn.mockRestore()
    }
  }, fuzzTestTimeout())
})
