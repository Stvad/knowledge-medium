// @vitest-environment node
/**
 * What the scheduled loop does with each run's answer.
 *
 * The copy itself is stubbed — `mirror.test.ts` covers what a run does to the
 * folder. What is under test here is the wiring: whether a run happens at all,
 * what it records, and whether the loop keeps going afterwards.
 */
import 'fake-indexeddb/auto'
import {IDBFactory} from 'fake-indexeddb'

import {beforeEach, describe, expect, it, vi} from 'vitest'
import type {Repo} from '@/data/repo'
import type {AppEffectContext} from '@/extensions/core'
import type {CadencedIdleJob} from '@/utils/cadencedIdleJob'
import {LAZY_DEEP_IDLE} from '@/utils/scheduleIdle.js'
import {
  BUSY_RETRY_MS,
  createDbMirrorSchedule,
  FAILURE_RETRY_MS,
  PERMISSION_LOST_MESSAGE,
} from '../schedule.js'
import {dbMirrorRuntimeHealth} from '../runtimeHealth.js'
import {createDbMirrorStore, type DbMirrorStore} from '../store.js'
import type {DbMirrorOutcome} from '../mirror.js'

const USER = 'alice'
const BOB = 'bob'
/** The identity `readDatabaseIncarnation` derives from this repo's log. */
const INCARNATION = '1700000000000'
const repo = {
  user: {id: USER},
  db: {
    getAll: async (sql: string) =>
      sql.includes('ORDER BY id LIMIT 1') ? [{born: 1700000000000}] : [{marker: 1}],
  },
} as unknown as Repo
/** Same repo, but with a log that cannot be READ — a different case from an
 *  empty one, and it still warrants a copy. */
const unreadableLogRepo = {
  user: {id: USER},
  db: {
    getAll: async (sql: string) => {
      if (sql.includes('ORDER BY id LIMIT 1')) throw new Error('no such table: row_events')
      return [{marker: 1}]
    },
  },
} as unknown as Repo

/** Same repo, but with an empty log — the database cannot name itself. */
const unidentifiableRepo = {
  user: {id: USER},
  db: {
    getAll: async (sql: string) =>
      sql.includes('ORDER BY id LIMIT 1') ? [{born: null}] : [{marker: 1}],
  },
} as unknown as Repo
const NOW = Date.UTC(2026, 8, 4, 13, 45, 2)
/** The enabled interval in `enable()`, so a test can say "a cadence later". */
const INTERVAL_MS = 120 * 60_000
/** Movable, because the cadence gate reads the clock: two runs at the same
 *  instant are one run as far as the device is concerned. */
let clock = NOW

/** A stand-in for `cadencedIdleJob` that hands the loop body straight back, so
 *  the tests drive runs instead of idle windows and timers. */
const fakeJob = () => {
  const state: {
    body: (() => Promise<number | void>) | null
    stopped: number
    rearms: Array<{loop: number; delayMs: number}>
    starts: number
  } = {
    body: null as (() => Promise<number | void>) | null,
    stopped: 0,
    /** Which loop got re-armed, and with what — the effect can restart, and a
     *  run in flight across that must not reschedule its successor. */
    rearms: [] as Array<{loop: number; delayMs: number}>,
    starts: 0,
  }
  const job: CadencedIdleJob = {
    drain: async () => {},
    start: (body) => {
      const loop = ++state.starts
      state.body = body
      return {
        stop: () => { state.stopped += 1; state.body = null },
        rearmIn: (delayMs) => state.rearms.push({loop, delayMs}),
      }
    },
  }
  return {job, state}
}

let store: DbMirrorStore
let outcomes: Array<DbMirrorOutcome | Error>
let mirror: ReturnType<typeof vi.fn>

const MIRRORED: DbMirrorOutcome = {
  kind: 'mirrored',
  filename: 'kmp-v6-alice-mirror-2026-09-04T13-45-02Z-a1b2c3d4-0aa60701-abc123.db',
  bytes: 2048,
  marker: '42',
  pruned: [],
  unmanaged: 0,
  verified: true,
}

beforeEach(() => {
  clock = NOW
  // Module state, and a failure from a previous test is not this test's.
  dbMirrorRuntimeHealth.report(undefined)
  globalThis.indexedDB = new IDBFactory()
  store = createDbMirrorStore()
  outcomes = [MIRRORED]
  mirror = vi.fn(async () => {
    const next = outcomes.length > 1 ? outcomes.shift()! : outcomes[0]
    if (next instanceof Error) throw next
    return next
  })
})

const build = (
  over: {
    lockHeldElsewhere?: boolean
    identifiable?: boolean
    /** A log that throws rather than one that is empty. */
    readableLog?: boolean
    /** A stand-in store, for the tests about a store that misbehaves. */
    store?: DbMirrorStore
  } = {},
) => {
  const {job, state} = fakeJob()
  const schedule = createDbMirrorSchedule({
    store: over.store ?? store,
    job,
    now: () => clock,
    mirror: mirror as never,
    withRunLock: over.lockHeldElsewhere
      ? async () => null
      : (async <T,>(_dbFilename: string, body: () => Promise<T>) => body()),
  })
  const stop = schedule.effect.start({
    repo: over.readableLog === false
      ? unreadableLogRepo
      : over.identifiable === false ? unidentifiableRepo : repo,
  } as unknown as AppEffectContext) as
    | (() => void)
    | undefined
  return {schedule, job: state, stop}
}

const enable = async (over: {directory?: boolean} = {}) => {
  await store.load(USER)
  await store.updateSettings(USER, {enabled: true, intervalMinutes: 120})
  if (over.directory !== false) {
    await store.setDirectory(USER, {kind: 'directory', name: 'Backups'} as never)
  }
}

describe('the mirror schedule', () => {
  it('does not copy while the setting is off', async () => {
    await store.load(USER)
    await store.setDirectory(USER, {kind: 'directory', name: 'Backups'} as never)
    const {job} = build()

    await expect(job.body!()).resolves.toBeGreaterThan(0)

    expect(mirror).not.toHaveBeenCalled()
  })

  it('does not copy before a folder has been chosen', async () => {
    await enable({directory: false})
    const {job} = build()

    await job.body!()

    expect(mirror).not.toHaveBeenCalled()
  })

  it('clears a status that describes a database this device no longer holds', async () => {
    // Withholding it from the RUN is not enough: the health chip and the
    // settings surface read the same record and rendered the previous
    // database's last copy as this one's — so after the wipe this feature
    // exists for, the chip said "Database mirror is on" naming a copy of a
    // database that was gone. Cleared at the source, so no reader needs to
    // remember to check a neighbouring field.
    await enable()
    await store.recordStatus(USER, {
      incarnation: 'a-database-that-is-gone',
      lastOutcome: 'mirrored',
      lastMirrorAt: NOW - 3_600_000,
      lastCheckedAt: NOW - 3_600_000,
      lastFilename: 'old.db',
      lastBytes: 4096,
      lastMarker: '42',
    })
    outcomes = [{kind: 'permission-lost', permission: 'prompt'}]
    const {job} = build()

    await job.body!()

    const {status} = await store.load(USER)
    expect(status.incarnation).toBe(INCARNATION)
    expect(status.lastMirrorAt).toBeUndefined()
    expect(status.lastFilename).toBeUndefined()
    expect(status.lastBytes).toBeUndefined()
    expect(status.lastMarker).toBeUndefined()
    expect(status.lastCheckedAt).toBeUndefined()
  })

  it('still copies when the log cannot be READ, which is not the same as empty', async () => {
    // An empty log is a fact about the database and means there is nothing to
    // protect. An unreadable one says nothing about whether the FILE copies —
    // the export streams raw bytes — and a partly damaged database is exactly
    // when a byte copy is worth most.
    await enable()
    const {job} = build({readableLog: false})

    await job.body!()

    expect(mirror).toHaveBeenCalledWith(expect.objectContaining({incarnation: undefined}))
  })

  it('clears the previous database’s copy even when the new one has no log yet', async () => {
    // THE post-wipe window. A rebuilt database has an empty `row_events` until
    // sync repopulates it, so the run that refuses to copy is the one on screen
    // while the user is looking for their backup — and it was leaving the
    // pre-wipe copy on the record, so the settings surface named a file that
    // describes a database that is gone.
    await enable()
    await store.recordStatus(USER, {
      incarnation: 'a-database-that-is-gone',
      lastOutcome: 'mirrored',
      lastMirrorAt: NOW - 3_600_000,
      lastFilename: 'old.db',
    })
    const {job} = build({identifiable: false})

    await job.body!()

    const {status} = await store.load(USER)
    expect(status.lastMirrorAt).toBeUndefined()
    expect(status.lastFilename).toBeUndefined()
    expect(status.incarnation).toBeUndefined()
    expect(status.lastOutcome).toBe('no-identity')
  })

  it('does not let a failure from last week shadow what this run concluded', async () => {
    // Only two verdicts used to clear `lastError`, so the chip went on
    // reporting "Last database mirror failed" with a stale message over a run
    // that had reached a perfectly good verdict — the inference that recording
    // verdicts was introduced to replace.
    await enable()
    await store.recordStatus(USER, {lastError: 'the disk was full last week', lastErrorAt: 1})
    const {job} = build({identifiable: false})

    await job.body!()

    const {status} = await store.load(USER)
    expect(status.lastError).toBeUndefined()
    expect(status.lastOutcome).toBe('no-identity')
  })

  it('does not park the loop past the cadence when the clock was fast', async () => {
    // A `lastCheckedAt` from a fast clock made `due` arbitrarily large, and
    // every reload re-read the same record and re-armed just as far out, with
    // nothing looking wrong — the gate and the staleness test both read a
    // negative age as recent.
    await enable()
    await store.recordStatus(USER, {lastCheckedAt: NOW + 4 * 365 * 24 * 3_600_000})

    const {job} = build()

    await vi.waitFor(() => expect(job.rearms.length).toBeGreaterThan(0))
    expect(job.rearms.at(-1)?.delayMs).toBeLessThanOrEqual(INTERVAL_MS)
  })

  it('records the verdict of a run that wrote nothing, not just of one that copied', async () => {
    await enable()
    const {job} = build({identifiable: false})

    await job.body!()

    expect((await store.load(USER)).status).toMatchObject({
      lastOutcome: 'no-identity',
      lastOutcomeAt: NOW,
    })
  })

  it('holds the device off briefly after a run that threw, but not after one that merely refused', async () => {
    // A failed export can have held PowerSync's write lock for its full
    // deadline, and the effect restarts on every workspace change — so without
    // a floor a restart repeats it at once, and N tabs each do. The cheap
    // verdicts have nothing to protect against repeating.
    await enable()
    const {job} = build()
    await job.body!()
    clock += INTERVAL_MS
    outcomes = [new Error('the drive is full')]
    await job.body!()
    expect(mirror).toHaveBeenCalledTimes(2)

    // A fresh loop, as an effect restart gives it.
    clock += 60_000
    const restarted = build()
    await restarted.job.body!()

    expect(mirror).toHaveBeenCalledTimes(2)
  })

  it('does not trust a status recorded against a different database', async () => {
    // An import replaced the database, or the browser wiped the local store and
    // the app rebuilt it. Inheriting the old marker would have the fresh
    // database conclude there is nothing to copy.
    await enable()
    await store.recordStatus(USER, {
      incarnation: 'a-database-that-is-gone',
      lastMarker: '42',
      lastFilename: 'old.db',
    })
    const {job} = build()

    await job.body!()

    expect(mirror).toHaveBeenCalledWith(expect.objectContaining({lastCopy: undefined}))
  })

  it('mints an install id rather than running without an owner', async () => {
    // A run with no install group writes a copy no scan will ever match again,
    // so nothing can prune it and nothing can prove it is ours. Minting is the
    // only answer that keeps ownership decidable; refusing to copy would trade
    // a leaked file for a missing backup, and carrying an "unknown install"
    // through the run is what produced immortal copies before.
    await enable()
    const expected = (await store.load(USER)).installId
    expect(expected).toBeDefined()
    const {job} = build({
      store: {
        ...store,
        load: async (userId) => ({...(await store.load(userId)), installId: undefined}),
      },
    })

    await job.body!()

    expect(mirror).toHaveBeenCalledWith(expect.objectContaining({installId: expected}))
  })

  it('writes nothing at all when the database cannot say which database it is', async () => {
    // An EMPTY log only. It is a fact about the database — `row_events` is never
    // trimmed, so no local writes have happened and there is nothing in the
    // upload queue either. An UNREADABLE log is the other case and does take a
    // copy; the test below pins that.
    await enable()
    const {job} = build({identifiable: false})

    const next = await job.body!()

    expect(mirror).not.toHaveBeenCalled()
    expect(next).toBe(INTERVAL_MS)
  })

  it('does not record a completed check when it could not identify the database', async () => {
    // `lastCheckedAt` is what the cadence gate reads. Stamping it here would
    // defer the retry for a whole interval on a condition that clears itself
    // the moment sync writes the log's first event.
    await enable()
    const {job} = build({identifiable: false})

    await job.body!()

    expect((await store.load(USER)).status.lastCheckedAt).toBeUndefined()
  })

  describe('the cadence belongs to the device, not to this tab', () => {
    // Every tab runs its own loop against the same folder. Before this, two
    // tabs took two full copies per interval — two holds of PowerSync's write
    // lock, and a keep count spanning half the history the user asked for.

    it('leaves the copy alone when a run on this device already covered the interval', async () => {
      await enable()
      const {job} = build()
      await job.body!()
      expect(mirror).toHaveBeenCalledTimes(1)

      clock = NOW + 5 * 60_000
      const next = await job.body!()

      expect(mirror).toHaveBeenCalledTimes(1)
      // And it comes back when the copy is actually due, rather than on a fixed
      // retry that would land early and take a second copy anyway.
      expect(next).toBe(INTERVAL_MS - 5 * 60_000)
    })

    it('copies once the interval has actually elapsed', async () => {
      await enable()
      const {job} = build()
      await job.body!()

      clock = NOW + INTERVAL_MS
      await job.body!()

      expect(mirror).toHaveBeenCalledTimes(2)
    })

    it('does not defer on a run recorded against a different database', async () => {
      // A wipe rebuilt the database moments after the last run. That run says
      // nothing about whether the database in front of us has been copied.
      await enable()
      await store.recordStatus(USER, {
        incarnation: 'a-database-that-is-gone',
        lastCheckedAt: NOW,
      })
      const {job} = build()

      await job.body!()

      expect(mirror).toHaveBeenCalledTimes(1)
    })

    it('does not defer when the clock jumped backwards', async () => {
      // A negative age would otherwise read as "inside the interval" and defer
      // for as long as the skew lasts.
      await enable()
      const {job} = build()
      await job.body!()

      clock = NOW - 24 * 60 * 60_000
      await job.body!()

      expect(mirror).toHaveBeenCalledTimes(2)
    })

    it('takes the copy even when it joins a scheduled run that gated itself', async () => {
      // "Mirror now" pressed in the same instant a scheduled tick starts joins
      // that tick rather than starting a second one — the two must not overlap.
      // If the tick then defers on the cadence, the join would hand the user
      // the tick's answer to a question they did not ask.
      await enable()
      const {schedule, job} = build()
      await job.body!()

      clock = NOW + 60_000
      const scheduled = job.body!()
      const manual = schedule.runNow(repo)

      expect(await scheduled).toBe(INTERVAL_MS - 60_000)
      expect((await manual).outcome).toMatchObject({kind: 'mirrored'})
      expect(mirror).toHaveBeenCalledTimes(2)
    })

    it('takes the copy anyway when the user asks for one by hand', async () => {
      // "Mirror now" asks for a copy, not for the cadence to be honoured.
      await enable()
      const {schedule, job} = build()
      await job.body!()

      clock = NOW + 60_000
      const {outcome} = await schedule.runNow(repo)

      expect(mirror).toHaveBeenCalledTimes(2)
      expect(outcome).toMatchObject({kind: 'mirrored'})
    })
  })

  describe('a failure the store is too broken to record', () => {
    // `store.load` deliberately rejects rather than answering with defaults, so
    // a run that cannot read its settings cannot write that it could not — the
    // write goes through the same store. Without an in-memory channel the last
    // good record stands and the chip reports a healthy mirror forever.

    const withBrokenStore = () =>
      build({store: {...store, load: async () => { throw new Error('IndexedDB is gone') }}})

    it('reports it somewhere the chip can still see', async () => {
      const {job} = withBrokenStore()

      await job.body!()

      expect(dbMirrorRuntimeHealth.getSnapshot()).toBe('IndexedDB is gone')
    })

    it('does not carry across a teardown to whatever starts next', async () => {
      // Module state with no owner: local-only sign-out swaps the repo without
      // a reload, so a failure left set is shown against the NEXT account's
      // mirror until a tick clears it — and the first tick waits for a
      // genuinely idle main thread, which a busy session may never give.
      const {job, stop} = withBrokenStore()
      await job.body!()
      expect(dbMirrorRuntimeHealth.getSnapshot()).toBeDefined()

      stop?.()

      expect(dbMirrorRuntimeHealth.getSnapshot()).toBeUndefined()
    })

    it('forgets it once a run gets through', async () => {
      const {job: broken} = withBrokenStore()
      await broken.body!()

      await enable()
      const {job} = build()
      await job.body!()

      expect(dbMirrorRuntimeHealth.getSnapshot()).toBeUndefined()
    })
  })

  it('does not leave an armed loop behind when starting throws', async () => {
    // The effect runtime records `cleanup: undefined` for a `start` that threw,
    // so a loop armed before the throw would tick forever against a repo that
    // may since have been replaced, with nothing able to stop it.
    await enable()
    const {job: jobHandle, state} = fakeJob()
    const schedule = createDbMirrorSchedule({
      store: {...store, subscribe: () => { throw new Error('subscribe blew up') }},
      job: jobHandle,
      now: () => clock,
      mirror: mirror as never,
      withRunLock: (async <T,>(_db: string, body: () => Promise<T>) => body()),
    })

    expect(() => schedule.effect.start({repo} as unknown as AppEffectContext)).toThrow(/subscribe/)
    expect(state.stopped).toBe(1)
  })

  it('records how many copies it may not touch, so the folder can explain itself', async () => {
    // The keep count does not govern another device's copies or those of a
    // database this one replaced, so a folder holding six copies under a keep
    // count of three is correct and looks broken. Nothing else can say why.
    await enable()
    outcomes = [{...MIRRORED, unmanaged: 2}]
    const {job} = build()

    await job.body!()

    expect((await store.load(USER)).status.unmanagedCopies).toBe(2)
  })

  describe('a status write that fails', () => {
    // Bookkeeping ABOUT the run. It must not turn a finished copy into a
    // failure, and on the error path it must not replace the error the caller
    // is about to see with its own.

    const withFailingStatusWrites = () =>
      build({
        store: {
          ...store,
          recordStatus: async () => { throw new Error('the status write failed') },
        },
      })

    it('does not turn a finished copy into a failure', async () => {
      await enable()
      const {schedule} = withFailingStatusWrites()

      const report = await schedule.runNow(repo)

      expect(report.outcome).toMatchObject({kind: 'mirrored'})
    })

    it('does not replace the error the caller is about to see', async () => {
      await enable()
      outcomes = [new Error('The disk is full')]
      const {schedule} = withFailingStatusWrites()

      await expect(schedule.runNow(repo)).rejects.toThrow('The disk is full')
    })
  })

  it('copies once enabled, and records what it wrote', async () => {
    await enable()
    const {job} = build()

    const next = await job.body!()

    expect(mirror).toHaveBeenCalledTimes(1)
    expect(next).toBe(120 * 60_000)
    expect((await store.load(USER)).status).toMatchObject({
      lastMarker: '42',
      lastMirrorAt: NOW,
      lastFilename: MIRRORED.filename,
      lastBytes: 2048,
    })
  })

  it('passes the last copy — marker, filename AND size — to the next run', async () => {
    await enable()
    const {job} = build()
    await job.body!()

    outcomes = [{kind: 'skipped-unchanged', marker: '42', pruned: [], unmanaged: 0}]
    clock = NOW + INTERVAL_MS
    await job.body!()

    // All three, because the skip needs all three: the marker says the database
    // has not moved, the filename lets the run look for the copy, and the size
    // tells an intact file from one an interrupted sync truncated.
    expect(mirror).toHaveBeenLastCalledWith(
      expect.objectContaining({
        lastCopy: {marker: '42', filename: MIRRORED.filename, bytes: MIRRORED.bytes},
      }),
    )
    // A skipped run is still a completed check, and it leaves the copy on disk
    // as the last successful mirror.
    const {status} = await store.load(USER)
    expect(status.lastCheckedAt).toBe(NOW + INTERVAL_MS)
    expect(status.lastMirrorAt).toBe(NOW)
  })

  describe('a lost folder permission', () => {
    it('says so and keeps checking on the ordinary cadence', async () => {
      // NOT halted. A tick cannot prompt — it only queries the standing grant —
      // so there is nothing to protect the user from by stopping, and a stopped
      // loop is what left other tabs dark after a re-grant elsewhere.
      await enable()
      outcomes = [{kind: 'permission-lost', permission: 'prompt'}]
      const {job} = build()

      const next = await job.body!()

      expect(next).toBe(120 * 60_000)
      expect(job.stopped).toBe(0)
      expect((await store.load(USER)).status).toMatchObject({
        permissionLost: true,
        lastError: PERMISSION_LOST_MESSAGE,
      })
    })

    it('leaves the last successful mirror on the record', async () => {
      await enable()
      const {job} = build()
      await job.body!()

      outcomes = [{kind: 'permission-lost', permission: 'denied'}]
      clock = NOW + INTERVAL_MS
      await job.body!()

      expect((await store.load(USER)).status).toMatchObject({
        lastMirrorAt: NOW,
        lastFilename: MIRRORED.filename,
        permissionLost: true,
      })
    })

    it('recovers by itself once the grant is back — no wake-up needed', async () => {
      // The grant can come back in ANOTHER tab, or through browser settings.
      // This tab hears about neither, so recovery has to be something its own
      // next tick discovers.
      await enable()
      outcomes = [{kind: 'permission-lost', permission: 'prompt'}]
      const {job} = build()
      await job.body!()

      outcomes = [MIRRORED]
      await job.body!()

      expect(mirror).toHaveBeenCalledTimes(2)
      expect((await store.load(USER)).status).toMatchObject({
        permissionLost: false,
        lastFilename: MIRRORED.filename,
      })
    })

    it('is forgotten once a run gets through, even one that copied nothing', async () => {
      // Access can come back outside the dialog — the user restores it in
      // browser site settings. Reaching an unchanged check at all means the
      // permission held and the folder was read, so leaving the warning up
      // would have the chip report a paused mirror that is running fine.
      await enable()
      outcomes = [{kind: 'permission-lost', permission: 'prompt'}]
      const {job} = build()
      await job.body!()
      expect((await store.load(USER)).status.permissionLost).toBe(true)

      outcomes = [{kind: 'skipped-unchanged', marker: '42', pruned: [], unmanaged: 0}]
      await job.body!()

      const {status} = await store.load(USER)
      expect(status.permissionLost).toBe(false)
      expect(status.lastError).toBeUndefined()
    })
  })

  it('records a failed run and comes back on the short retry', async () => {
    await enable()
    outcomes = [new Error('The disk is full')]
    const {job} = build()

    expect(await job.body!()).toBe(FAILURE_RETRY_MS)

    expect((await store.load(USER)).status).toMatchObject({
      lastError: 'The disk is full',
      lastErrorAt: NOW,
    })
  })

  it('backs off while a failure keeps repeating, and recovers the cadence after a success', async () => {
    // Driven by the delay the loop ACTUALLY returns, not by a fixed advance:
    // the previous version stepped the clock a whole interval between ticks, a
    // sequence production never produces, and so it passed while the ladder was
    // unreachable — every retry was being cancelled by the cadence gate.
    await enable()
    outcomes = [new Error('the copy did not finish in time')]
    const {job} = build()

    const delays: number[] = []
    for (let i = 0; i < 6; i += 1) {
      const next = await job.body!()
      delays.push(next as number)
      clock += next as number
    }

    expect(delays).toEqual([
      FAILURE_RETRY_MS,
      2 * FAILURE_RETRY_MS,
      4 * FAILURE_RETRY_MS,
      8 * FAILURE_RETRY_MS,
      16 * FAILURE_RETRY_MS,
      // Capped: a mirror that never succeeds costs no more than one that always does.
      INTERVAL_MS,
    ])
    expect(mirror).toHaveBeenCalledTimes(6)

    outcomes = [MIRRORED]
    clock += INTERVAL_MS
    expect(await job.body!()).toBe(INTERVAL_MS)

    // And the widening starts over, rather than resuming where the last streak
    // left off — a single transient failure after a healthy week should cost
    // five minutes, not the cadence.
    outcomes = [new Error('a passing hiccup')]
    clock += INTERVAL_MS
    expect(await job.body!()).toBe(FAILURE_RETRY_MS)
  })

  it('does not record a copy it could not read back as the copy to skip against', async () => {
    // The bytes are committed, so the file is kept — but nothing here saw it.
    // Recording it would have the chip assert a backup for a whole interval and
    // let the next run skip against a file it never confirmed.
    await enable()
    outcomes = [{...MIRRORED, verified: false}]
    const {job} = build()

    await job.body!()

    const {status} = await store.load(USER)
    expect(status.lastOutcome).toBe('mirrored')
    expect(status.lastFilename).toBeUndefined()
    expect(status.lastMarker).toBeUndefined()
    expect(status.lastMirrorAt).toBeUndefined()
  })

  it('does not defer a retry because the clock jumped backwards after a failure', async () => {
    // Same rule as the cadence gate one line up, and it was the untested copy
    // of it: a negative age would otherwise read as "inside the window".
    await enable()
    const {job} = build()
    outcomes = [new Error('the drive is full')]
    await job.body!()
    expect(mirror).toHaveBeenCalledTimes(1)

    clock -= 24 * 3_600_000
    await job.body!()

    expect(mirror).toHaveBeenCalledTimes(2)
  })

  it('does not let a run outlive its effect and clear a newer one’s slot', async () => {
    // Stopping an effect does not recall a run already in flight — `loop.stop`
    // only cancels a pending timer — and a copy can outlast the 60s before the
    // replacement's first tick. Without the identity check the stale run's
    // cleanup clears the NEW user's in-flight entry, and the next caller then
    // starts a second run overlapping it in the same tab.
    await enable()
    await store.load(BOB)
    await store.updateSettings(BOB, {enabled: true, intervalMinutes: 120})
    await store.setDirectory(BOB, {kind: 'directory', name: 'Backups'} as never)

    const held: Array<() => void> = []
    mirror.mockImplementation(async () => {
      await new Promise<void>(resolve => held.push(resolve))
      return MIRRORED
    })
    const {schedule, stop} = build()

    const alice = schedule.runNow(repo)
    stop?.()
    const other = {...repo, user: {id: BOB}} as unknown as Repo
    const bobFirst = schedule.runNow(other)
    await vi.waitFor(() => expect(mirror).toHaveBeenCalledTimes(2))

    // Alice's run settles while bob's is still in flight.
    held[0]!()
    await alice

    // Joins bob's run rather than starting a third one beside it.
    const bobSecond = schedule.runNow(other)
    await Promise.resolve()
    expect(mirror).toHaveBeenCalledTimes(2)

    held.forEach(release => release())
    await Promise.all([bobFirst, bobSecond])
  })

  it('does not record a copy into a folder the user has since replaced', async () => {
    // A run is not instantaneous. Picking a new folder mid-copy used to leave
    // the old folder's result on the record with a fresh `lastCheckedAt`, so
    // the cadence gate deferred the FIRST copy into the new folder for a whole
    // interval — a week at the longest setting — while the chip said nothing
    // and the dialog named a file that was not in the chosen folder.
    await enable()
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    mirror.mockImplementationOnce(async () => { await held; return MIRRORED })
    const {job} = build()

    const inFlight = job.body!()
    await vi.waitFor(() => expect(mirror).toHaveBeenCalled())
    await store.setDirectory(USER, {kind: 'directory', name: 'Elsewhere'} as never)
    release()
    await inFlight

    const {status} = await store.load(USER)
    expect(status.lastFilename).toBeUndefined()
    expect(status.lastCheckedAt).toBeUndefined()

    // And the next run is therefore free to copy into the new folder at once.
    clock += 60_000
    await job.body!()
    expect(mirror).toHaveBeenCalledTimes(2)
  })

  it('does not let a failed run defer the retry it just asked for', async () => {
    // `lastCheckedAt` is the cadence gate's input and means "a run COMPLETED".
    // A run that threw completed nothing; stamping it there made the 5-minute
    // retry land, get gated, and come back as most of an interval.
    await enable()
    const {job} = build()
    await job.body!()

    clock += INTERVAL_MS
    outcomes = [new Error('The disk is full')]
    expect(await job.body!()).toBe(FAILURE_RETRY_MS)

    clock += FAILURE_RETRY_MS
    await job.body!()

    expect(mirror).toHaveBeenCalledTimes(3)
  })

  it('copies once the folder permission is granted again, rather than waiting out the cadence', async () => {
    // The re-grant clears `permissionLost`, but the ticks that recorded it must
    // not have advanced the cadence — otherwise a user who fixes the folder on
    // a weekly schedule gets no copy for nearly a week, while the chip reports
    // a healthy mirror because nothing looks stale.
    await enable()
    outcomes = [{kind: 'permission-lost', permission: 'prompt'}]
    const {job} = build()
    await job.body!()
    expect((await store.load(USER)).status.lastCheckedAt).toBeUndefined()

    outcomes = [MIRRORED]
    clock += 2 * 60_000
    await job.body!()

    expect(mirror).toHaveBeenCalledTimes(2)
  })

  it('does not report a full disk as a lost folder permission', async () => {
    // The permission check runs before the copy and returns rather than
    // throwing, so a throw is some other failure. A stale flag left set would
    // have the chip offer "Grant access again" for a full disk.
    await enable()
    outcomes = [{kind: 'permission-lost', permission: 'prompt'}]
    const {job} = build()
    await job.body!()
    expect((await store.load(USER)).status.permissionLost).toBe(true)

    outcomes = [new Error('The disk is full')]
    clock = NOW + INTERVAL_MS
    await job.body!()

    const {status} = await store.load(USER)
    expect(status.permissionLost).toBe(false)
    expect(status.lastError).toBe('The disk is full')
  })

  describe('another tab already mirroring', () => {
    it('stands down, and comes back well before the full cadence', async () => {
      // The holder may be mid-copy — or may have crashed, closed, or failed. On
      // a weekly cadence, waiting it out would leave the survivor idle for days.
      await enable()
      const {job} = build({lockHeldElsewhere: true})

      const next = await job.body!()

      expect(next).toBe(BUSY_RETRY_MS)
      // Nothing recorded: the tab holding the lock is writing the same status.
      expect((await store.load(USER)).status).toEqual({})
    })

    it('reports it from "Mirror now" without claiming a copy was made', async () => {
      await enable()
      const {schedule} = build({lockHeldElsewhere: true})

      const report = await schedule.runNow(repo)

      expect(report.outcome).toEqual({kind: 'busy-elsewhere'})
    })
  })

  it('does not hand a newly signed-in user the previous user’s run', async () => {
    // Local-only sign-out swaps the repo without a reload, so a large export
    // for the previous user can still be running when the new one arrives.
    await enable()
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    mirror.mockImplementationOnce(async () => { await held; return MIRRORED })
    const {schedule, job} = build()

    const previousUser = job.body!()
    const other = {user: {id: 'bob'}} as unknown as Repo
    const bobsReport = await schedule.runNow(other)
    release()
    await previousUser

    // Bob has no settings of his own, so his run is a no-op — but it is HIS
    // no-op, not alice's mirrored copy.
    expect(bobsReport.outcome).toEqual({kind: 'disabled'})
  })

  it('joins a run already in flight rather than taking a second copy', async () => {
    await enable()
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    mirror.mockImplementationOnce(async () => { await held; return MIRRORED })
    const {schedule, job} = build()

    const scheduled = job.body!()
    const manual = schedule.runNow(repo)
    release()
    const [, report] = await Promise.all([scheduled, manual])

    expect(mirror).toHaveBeenCalledTimes(1)
    expect(report.outcome).toEqual(MIRRORED)
  })

  describe('running now from settings', () => {
    it('brings the retry forward when it fails, instead of leaving the old timer', async () => {
      // A scheduled run that throws gets the job's failure delay; a manual one
      // has no such backstop, so on a weekly cadence the automatic retry could
      // be days away.
      await enable()
      outcomes = [new Error('The disk is full')]
      const {schedule, job} = build()

      await expect(schedule.runNow(repo)).rejects.toThrow('The disk is full')

      expect(job.rearms).toEqual([{loop: 1, delayMs: FAILURE_RETRY_MS}])
    })

    it('goes through the same path as a scheduled run', async () => {
      await enable()
      const {schedule} = build()

      const report = await schedule.runNow(repo)

      expect(report.outcome).toEqual(MIRRORED)
      expect((await store.load(USER)).status.lastMirrorAt).toBe(NOW)
    })

    it('re-arms the loop so the next scheduled run is a full interval away', async () => {
      await enable()
      const {schedule, job} = build()

      await schedule.runNow(repo)

      expect(job.rearms).toEqual([{loop: 1, delayMs: 120 * 60_000}])
    })

    it('reports the folder being off-limits', async () => {
      await enable()
      outcomes = [{kind: 'permission-lost', permission: 'denied'}]
      const {schedule} = build()

      const report = await schedule.runNow(repo)

      expect(report.outcome).toMatchObject({kind: 'permission-lost'})
    })

    it('does not reschedule the loop that replaced the one it started against', async () => {
      // Local-only sign-out swaps the repo mid-copy. ONE schedule whose effect
      // restarts — which is what production has — so the stale continuation is
      // holding a handle to a loop that is gone.
      await enable()
      let release!: () => void
      const held = new Promise<void>(resolve => { release = resolve })
      mirror.mockImplementationOnce(async () => { await held; return MIRRORED })
      const {schedule, job, stop} = build()

      const manual = schedule.runNow(repo)
      stop?.()
      schedule.effect.start({
        repo: {...repo, user: {id: 'bob'}},
      } as unknown as AppEffectContext)
      release()
      await manual

      expect(job.starts).toBe(2)
      // The WHOLE array. Filtering to loop 2 could never have caught this: the
      // stale continuation holds loop 1's handle, so a leaked re-arm is
      // recorded against loop 1 and the filter never sees it.
      expect(job.rearms).toEqual([])
    })
  })

  it('stops the loop when the effect is torn down', async () => {
    await enable()
    const {job, stop, schedule} = build()

    stop?.()

    expect(job.stopped).toBe(1)
    // A settings surface left open must not re-arm a torn-down effect.
    schedule.resume()
    expect(job.rearms).toEqual([])
  })

  describe('a setting changed in another tab', () => {
    it('re-arms this tab on the new interval', async () => {
      // The settings surface re-arms the tab it runs in; the store's broadcast
      // is what carries the change here. Without this, shortening the cadence
      // from weekly to half-hourly leaves other tabs dormant for a week.
      await enable()
      const {job} = build()
      await vi.waitFor(() => expect(store.getSnapshot()?.settings.intervalMinutes).toBe(120))

      await store.updateSettings(USER, {intervalMinutes: 30})

      await vi.waitFor(() =>
        expect(job.rearms).toContainEqual({loop: 1, delayMs: 30 * 60_000}),
      )
    })

    it('does not re-arm on the first reading, which would delay the first copy', async () => {
      await enable()
      // A FRESH store, so its snapshot is null when the effect starts and the
      // subscriber's first reading really is its first. Against the store
      // `enable()` used, the interval is already published before `build()`
      // runs, so the subscriber returns early on equality and the baseline
      // branch is never reached — the assertion below then holds with the
      // branch deleted.
      store = createDbMirrorStore()
      const {job} = build()

      await vi.waitFor(() => expect(store.getSnapshot()?.settings.intervalMinutes).toBe(120))

      expect(job.rearms).toEqual([])
    })

    it('does not re-arm for a status write, which would restart the cadence forever', async () => {
      await enable()
      const {job} = build()
      await vi.waitFor(() => expect(store.getSnapshot()?.settings.intervalMinutes).toBe(120))

      await store.recordStatus(USER, {lastCheckedAt: 1})

      expect(job.rearms).toEqual([])
    })
  })

  describe('restarting for a workspace change', () => {
    it('picks up where the last completed run left off', async () => {
      // The reconciler restarts every effect when the workspace changes, and
      // this feature is per-database rather than per-workspace — so a fresh
      // first delay each time would let someone who switches often postpone
      // mirroring for good.
      await enable()
      await store.recordStatus(USER, {lastCheckedAt: NOW - 30 * 60_000})
      store = createDbMirrorStore()
      const {job} = build()

      // 120-minute cadence, 30 minutes elapsed: 90 left, not a fresh start.
      await vi.waitFor(() =>
        expect(job.rearms).toContainEqual({loop: 1, delayMs: 90 * 60_000}),
      )
    })

    it('never comes due sooner than the job\u2019s own floor', async () => {
      await enable()
      await store.recordStatus(USER, {lastCheckedAt: NOW - 10 * 60 * 60_000})
      store = createDbMirrorStore()
      const {job} = build()

      await vi.waitFor(() => expect(job.rearms.length).toBeGreaterThan(0))
      expect(job.rearms[0].delayMs).toBe(LAZY_DEEP_IDLE.minDelayMs)
    })

    it('leaves a first-ever run on the job\u2019s own first delay', async () => {
      await enable()
      store = createDbMirrorStore()
      const {job} = build()

      await vi.waitFor(() => expect(store.getSnapshot()).not.toBeNull())
      expect(job.rearms).toEqual([])
    })
  })

  it('publishes the persisted state as soon as it starts', async () => {
    // Otherwise the health chip has nothing to show until the first scheduled
    // run, which waits for a genuinely idle main thread and may never come.
    await enable()
    await store.recordStatus(USER, {permissionLost: true, lastError: 'the grant lapsed', lastErrorAt: 1})
    store = createDbMirrorStore()
    build()

    await vi.waitFor(() => expect(store.getSnapshot()?.status.permissionLost).toBe(true))
  })
})
