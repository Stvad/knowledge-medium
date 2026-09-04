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
import {
  BUSY_RETRY_MS,
  createDbMirrorSchedule,
  FAILURE_RETRY_MS,
  PERMISSION_LOST_MESSAGE,
} from '../schedule.js'
import {createDbMirrorStore, type DbMirrorStore} from '../store.js'
import type {DbMirrorOutcome} from '../mirror.js'

const USER = 'alice'
/** The identity `readDatabaseIncarnation` derives from this repo's log. */
const INCARNATION = '1700000000000'
const repo = {
  user: {id: USER},
  db: {
    getAll: async (sql: string) =>
      sql.includes('MIN(created_at)') ? [{born: 1700000000000}] : [{marker: 1}],
  },
} as unknown as Repo
const NOW = Date.UTC(2026, 8, 4, 13, 45, 2)

/** A stand-in for `cadencedIdleJob` that hands the loop body straight back, so
 *  the tests drive runs instead of idle windows and timers. */
const fakeJob = () => {
  const state = {
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
  filename: 'kmp-v6-alice-mirror-2026-09-04T13-45-02Z-aa6070-abc123.db',
  bytes: 2048,
  marker: '42',
  pruned: [],
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  store = createDbMirrorStore()
  outcomes = [MIRRORED]
  mirror = vi.fn(async () => {
    const next = outcomes.length > 1 ? outcomes.shift()! : outcomes[0]
    if (next instanceof Error) throw next
    return next
  })
})

const build = (over: {supported?: () => boolean; lockHeldElsewhere?: boolean} = {}) => {
  const {job, state} = fakeJob()
  const schedule = createDbMirrorSchedule({
    store,
    job,
    now: () => NOW,
    supported: over.supported ?? (() => true),
    mirror: mirror as never,
    withRunLock: over.lockHeldElsewhere
      ? async () => null
      : (async <T,>(_dbFilename: string, body: () => Promise<T>) => body()),
  })
  const stop = schedule.effect.start({repo} as unknown as AppEffectContext) as
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
  it('arms nothing in a browser with no directory picker', () => {
    const {job, stop} = build({supported: () => false})
    expect(job.starts).toBe(0)
    expect(stop).toBeUndefined()
  })

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

  it('stamps the database identity onto what it records', async () => {
    await enable()
    const {job} = build()

    await job.body!()

    expect((await store.load(USER)).status.incarnation).toBe(INCARNATION)
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

  it('passes the last copy — marker AND filename — to the next run', async () => {
    await enable()
    const {job} = build()
    await job.body!()

    outcomes = [{kind: 'skipped-unchanged', marker: '42', pruned: []}]
    await job.body!()

    // Both, because the skip needs both: the marker says the database has not
    // moved, and only the filename lets the run check a copy is really there.
    expect(mirror).toHaveBeenLastCalledWith(
      expect.objectContaining({lastCopy: {marker: '42', filename: MIRRORED.filename}}),
    )
    // A skipped run is still a completed check, and it leaves the copy on disk
    // as the last successful mirror.
    const {status} = await store.load(USER)
    expect(status.lastCheckedAt).toBe(NOW)
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

      outcomes = [{kind: 'skipped-unchanged', marker: '42', pruned: []}]
      await job.body!()

      const {status} = await store.load(USER)
      expect(status.permissionLost).toBe(false)
      expect(status.lastError).toBeUndefined()
    })
  })

  it('records a failed run and lets the job take the short retry', async () => {
    await enable()
    outcomes = [new Error('The disk is full')]
    const {job} = build()

    await expect(job.body!()).rejects.toThrow('The disk is full')

    expect((await store.load(USER)).status).toMatchObject({
      lastError: 'The disk is full',
      lastErrorAt: NOW,
    })
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
      expect(job.rearms.filter(r => r.loop === 2)).toEqual([])
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
