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
import {createDbMirrorSchedule, PERMISSION_LOST_MESSAGE} from '../schedule.js'
import {createDbMirrorStore, type DbMirrorStore} from '../store.js'
import type {DbMirrorOutcome} from '../mirror.js'

const USER = 'alice'
const repo = {user: {id: USER}} as unknown as Repo
const NOW = Date.UTC(2026, 8, 4, 13, 45, 2)

/** A stand-in for `cadencedIdleJob` that hands the loop body straight back, so
 *  the tests drive runs instead of idle windows and timers. */
const fakeJob = () => {
  const state = {
    body: null as (() => Promise<number | void>) | null,
    stopped: 0,
    rearms: [] as number[],
    starts: 0,
  }
  const job: CadencedIdleJob = {
    drain: async () => {},
    start: (body) => {
      state.starts += 1
      state.body = body
      return {
        stop: () => { state.stopped += 1; state.body = null },
        rearmIn: (delayMs) => state.rearms.push(delayMs),
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
  filename: 'kmp-v6-alice-mirror-2026-09-04T13-45-02Z.db',
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

const build = (over: {supported?: () => boolean} = {}) => {
  const {job, state} = fakeJob()
  const schedule = createDbMirrorSchedule({
    store,
    job,
    now: () => NOW,
    supported: over.supported ?? (() => true),
    mirror: mirror as never,
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

  it('passes the last mirrored marker to the next run, so an unchanged database is skipped', async () => {
    await enable()
    const {job} = build()
    await job.body!()

    outcomes = [{kind: 'skipped-unchanged', marker: '42'}]
    await job.body!()

    expect(mirror).toHaveBeenLastCalledWith(expect.objectContaining({lastMarker: '42'}))
    // A skipped run is still a completed check, and it leaves the copy on disk
    // as the last successful mirror.
    const {status} = await store.load(USER)
    expect(status.lastCheckedAt).toBe(NOW)
    expect(status.lastMirrorAt).toBe(NOW)
  })

  describe('a lost folder permission', () => {
    it('stops the loop and says so, rather than retrying every idle tick', async () => {
      await enable()
      outcomes = [{kind: 'permission-lost', permission: 'prompt'}]
      const {job} = build()

      const next = await job.body!()

      expect(next).toBeUndefined()
      expect(job.stopped).toBe(1)
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

    it('starts running again only once settings re-grants it', async () => {
      await enable()
      outcomes = [{kind: 'permission-lost', permission: 'prompt'}]
      const {schedule, job} = build()
      await job.body!()
      expect(job.body).toBeNull()

      outcomes = [MIRRORED]
      schedule.resume()

      expect(job.starts).toBe(2)
      await job.body!()
      expect(mirror).toHaveBeenCalledTimes(2)
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

      expect(job.rearms).toEqual([120 * 60_000])
    })

    it('reports the folder being off-limits without restarting the loop', async () => {
      await enable()
      outcomes = [{kind: 'permission-lost', permission: 'denied'}]
      const {schedule, job} = build()

      const report = await schedule.runNow(repo)

      expect(report.outcome).toMatchObject({kind: 'permission-lost'})
      expect(job.rearms).toEqual([])
    })
  })

  it('stops the loop when the effect is torn down', async () => {
    await enable()
    const {job, stop, schedule} = build()

    stop?.()

    expect(job.stopped).toBe(1)
    // A settings surface left open must not revive a torn-down effect.
    schedule.resume()
    expect(job.starts).toBe(1)
  })
})
