// @vitest-environment node
/**
 * The drain loop against a real Repo and a fake `ArchiveService`.
 *
 * The service is injected through the same facet the Wayback implementation
 * uses, so these exercise the real resolution path — and no test here can
 * reach the network even if the seam were bypassed, because the fake never
 * calls fetch.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { webArchiveDataExtension } from '../dataExtension.ts'
import {
  archiveDailyLimitProp,
  archiveEnabledProp,
  archiveHourlyLimitProp,
  archiveNotifyThresholdProp,
  archiveServiceIdProp,
  loadPrefsBlock,
} from '../prefs.ts'
import { archiveServicesFacet, type ArchiveService, type ArchiveSubmission } from '../service.ts'
import { drainOnce, resetVolumeNotifications, type DrainDeps } from '../queue.ts'
import { MAX_ATTEMPTS } from '../rateLimit.ts'
import { createPendingRecords, queryAllRecords } from '../snapshots.ts'

const WS = 'ws-1'
const SOURCE = 'source-block'
const FAKE_ID = 'fake-archive'

let sharedDb: TestDb
let repo: Repo
let now: Date
let notices: string[]

interface FakeService {
  service: ArchiveService
  submit: ReturnType<typeof vi.fn>
  resolve: ReturnType<typeof vi.fn>
}

const makeService = (
  submitImpl: () => Promise<ArchiveSubmission> = async () => ({accepted: true}),
  resolveImpl: () => Promise<string | undefined> = async () => undefined,
): FakeService => {
  const submit = vi.fn(submitImpl)
  const resolve = vi.fn(resolveImpl)
  return {
    submit,
    resolve,
    service: {
      id: FAKE_ID,
      label: 'Fake archive',
      hosts: ['fake.archive.invalid'],
      privacyNote: 'test',
      submit: submit as unknown as ArchiveService['submit'],
      resolve: resolve as unknown as ArchiveService['resolve'],
    },
  }
}

const buildRepo = (fake: FakeService) => {
  repo = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    extensions: [
      webArchiveDataExtension,
      archiveServicesFacet.of(fake.service, {source: 'test'}),
    ],
  }).repo
  repo.setActiveWorkspaceId(WS)
}

const deps = (): DrainDeps => ({
  repo,
  workspaceId: WS,
  now: () => now,
  // Instant: the inter-submit gap is asserted by counting `sleep` calls, not
  // by making the suite wait five seconds per record.
  sleep: async () => {},
  isOnline: () => true,
  notify: message => { notices.push(message) },
})

const configure = async (overrides: {
  enabled?: boolean
  hourlyLimit?: number
  dailyLimit?: number
  notifyThreshold?: number
  serviceId?: string
} = {}) => {
  const prefs = await loadPrefsBlock(repo, WS)
  await prefs.set(archiveEnabledProp, overrides.enabled ?? true)
  await prefs.set(archiveServiceIdProp, overrides.serviceId ?? FAKE_ID)
  if (overrides.hourlyLimit !== undefined) await prefs.set(archiveHourlyLimitProp, overrides.hourlyLimit)
  if (overrides.dailyLimit !== undefined) await prefs.set(archiveDailyLimitProp, overrides.dailyLimit)
  if (overrides.notifyThreshold !== undefined) {
    await prefs.set(archiveNotifyThresholdProp, overrides.notifyThreshold)
  }
  await repo.awaitProcessors()
}

const seedSource = async () => {
  await repo.tx(async tx => {
    await tx.create({id: SOURCE, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'notes'})
  }, {scope: ChangeScope.BlockDefault})
  await repo.awaitProcessors()
}

const queue = async (...urls: string[]) => {
  await createPendingRecords(repo, urls.map(url => ({sourceId: SOURCE, url, serviceId: FAKE_ID})))
  await repo.awaitProcessors()
}

const records = async () => queryAllRecords(repo, WS)
const only = async () => {
  const all = await records()
  expect(all).toHaveLength(1)
  return all[0]!
}

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  resetVolumeNotifications()
  now = new Date('2026-07-30T12:00:00.000Z')
  notices = []
})

describe('gates', () => {
  it('sends nothing while the user has not opted in', async () => {
    const fake = makeService()
    buildRepo(fake)
    await configure({enabled: false})
    await seedSource()
    await queue('https://example.com/a')

    expect(await drainOnce(deps())).toMatchObject({skippedReason: 'disabled', submitted: 0})
    expect(fake.submit).not.toHaveBeenCalled()
  })

  it('sends nothing while offline', async () => {
    const fake = makeService()
    buildRepo(fake)
    await configure()
    await seedSource()
    await queue('https://example.com/a')

    const outcome = await drainOnce({...deps(), isOnline: () => false})
    expect(outcome).toMatchObject({skippedReason: 'offline'})
    expect(fake.submit).not.toHaveBeenCalled()
  })

  // Substituting a different archive because the configured one vanished
  // would publish to a third party the user never chose.
  it('sends nothing when the configured service is not registered', async () => {
    const fake = makeService()
    buildRepo(fake)
    await configure({serviceId: 'some-other-archive'})
    await seedSource()
    await queue('https://example.com/a')

    expect(await drainOnce(deps())).toMatchObject({skippedReason: 'no-service'})
    expect(fake.submit).not.toHaveBeenCalled()
  })
})

describe('submit → verify lifecycle', () => {
  it('submits a pending record and marks it submitted, not archived', async () => {
    const fake = makeService()
    buildRepo(fake)
    await configure()
    await seedSource()
    await queue('https://example.com/a')

    expect(await drainOnce(deps())).toMatchObject({submitted: 1})
    expect(fake.submit).toHaveBeenCalledWith('https://example.com/a')

    const record = await only()
    // Accepted ≠ archived: no archive URL has been read back yet.
    expect(record).toMatchObject({status: 'submitted', attempts: 1, archiveUrl: ''})
    expect(record.submittedAt?.toISOString()).toBe(now.toISOString())
  })

  it('promotes to archived only once a snapshot URL is read back', async () => {
    const fake = makeService()
    buildRepo(fake)
    await configure()
    await seedSource()
    await queue('https://example.com/a')
    await drainOnce(deps())

    // Nothing archived yet — resolve returns undefined, status must hold.
    now = new Date(now.getTime() + 5 * 60_000)
    expect(await drainOnce(deps())).toMatchObject({resolved: 0})
    expect((await only()).status).toBe('submitted')

    fake.resolve.mockResolvedValue('https://fake.archive.invalid/x/https://example.com/a')
    now = new Date(now.getTime() + 30 * 60_000)
    expect(await drainOnce(deps())).toMatchObject({resolved: 1})

    const record = await only()
    expect(record).toMatchObject({
      status: 'archived',
      archiveUrl: 'https://fake.archive.invalid/x/https://example.com/a',
    })
  })

  it('records the archive URL in the block content, next to the original', async () => {
    const fake = makeService(
      async () => ({accepted: true, archiveUrl: 'https://fake.archive.invalid/x'}),
    )
    buildRepo(fake)
    await configure()
    await seedSource()
    await queue('https://example.com/a')
    await drainOnce(deps())

    const rows = await repo.queryBlocks({workspaceId: WS, types: ['webarchive-snapshot']})
    expect(rows[0]?.content)
      .toBe('Archived https://example.com/a → https://fake.archive.invalid/x')
    // Alongside the original: the record is a child of the block that had it.
    expect(rows[0]?.parentId).toBe(SOURCE)
  })

  it('leaves an archived record alone on later ticks', async () => {
    const fake = makeService(
      async () => ({accepted: true, archiveUrl: 'https://fake.archive.invalid/x'}),
    )
    buildRepo(fake)
    await configure()
    await seedSource()
    await queue('https://example.com/a')
    await drainOnce(deps())

    now = new Date(now.getTime() + 2 * 60 * 60_000)
    expect(await drainOnce(deps())).toMatchObject({skippedReason: 'nothing-due'})
    expect(fake.submit).toHaveBeenCalledTimes(1)
  })
})

describe('failure handling', () => {
  it('keeps a failed submission pending and backs off before retrying', async () => {
    const fake = makeService(async () => { throw new Error('boom') })
    buildRepo(fake)
    await configure()
    await seedSource()
    await queue('https://example.com/a')

    expect(await drainOnce(deps())).toMatchObject({failed: 1})
    expect(await only()).toMatchObject({status: 'pending', attempts: 1, error: 'boom'})

    // Inside the backoff window — must not hammer the service.
    now = new Date(now.getTime() + 30_000)
    expect(await drainOnce(deps())).toMatchObject({skippedReason: 'nothing-due'})
    expect(fake.submit).toHaveBeenCalledTimes(1)

    now = new Date(now.getTime() + 2 * 60_000)
    await drainOnce(deps())
    expect(fake.submit).toHaveBeenCalledTimes(2)
  })

  it('gives up after MAX_ATTEMPTS instead of retrying forever', async () => {
    const fake = makeService(async () => { throw new Error('boom') })
    buildRepo(fake)
    await configure()
    await seedSource()
    await queue('https://example.com/a')

    for (let i = 0; i < MAX_ATTEMPTS + 2; i += 1) {
      await drainOnce(deps())
      now = new Date(now.getTime() + 2 * 60 * 60_000)
    }

    expect(await only()).toMatchObject({status: 'failed', attempts: MAX_ATTEMPTS})
    expect(fake.submit).toHaveBeenCalledTimes(MAX_ATTEMPTS)
  })

  it('clears a stale error when a retry succeeds', async () => {
    let fail = true
    const fake = makeService(async () => {
      if (fail) throw new Error('boom')
      return {accepted: true}
    })
    buildRepo(fake)
    await configure()
    await seedSource()
    await queue('https://example.com/a')

    await drainOnce(deps())
    expect((await only()).error).toBe('boom')

    fail = false
    now = new Date(now.getTime() + 5 * 60_000)
    await drainOnce(deps())
    expect(await only()).toMatchObject({status: 'submitted', error: undefined})
  })

  it('treats a service that declines to accept as a failure, not a success', async () => {
    const fake = makeService(async () => ({accepted: false}))
    buildRepo(fake)
    await configure()
    await seedSource()
    await queue('https://example.com/a')

    expect(await drainOnce(deps())).toMatchObject({failed: 1, submitted: 0})
    expect((await only()).status).toBe('pending')
  })
})

describe('rate limiting', () => {
  it('stops at the hourly ceiling and leaves the rest queued', async () => {
    const fake = makeService()
    buildRepo(fake)
    await configure({hourlyLimit: 2})
    await seedSource()
    await queue('https://example.com/a', 'https://example.com/b', 'https://example.com/c')

    expect(await drainOnce(deps())).toMatchObject({submitted: 2})
    expect(await drainOnce(deps())).toMatchObject({skippedReason: 'rate-limited'})
    expect(fake.submit).toHaveBeenCalledTimes(2)

    // Nothing was dropped — the third is still queued and goes out once the
    // rolling hour clears.
    const statuses = (await records()).map(r => r.status).sort()
    expect(statuses).toEqual(['pending', 'submitted', 'submitted'])

    now = new Date(now.getTime() + 61 * 60_000)
    expect(await drainOnce(deps())).toMatchObject({submitted: 1})
  })

  it('honours the daily ceiling independently of the hourly one', async () => {
    const fake = makeService()
    buildRepo(fake)
    await configure({hourlyLimit: 100, dailyLimit: 1})
    await seedSource()
    await queue('https://example.com/a', 'https://example.com/b')

    expect(await drainOnce(deps())).toMatchObject({submitted: 1})

    // Two hours on, the hourly window has cleared and the first record is due
    // for a read-back — so the tick is NOT a no-op. The daily ceiling still
    // has to hold back the second URL, which is why `rateLimited` is reported
    // separately from `skippedReason`.
    now = new Date(now.getTime() + 2 * 60 * 60_000)
    expect(await drainOnce(deps())).toMatchObject({submitted: 0, rateLimited: true})
    expect(fake.submit).toHaveBeenCalledTimes(1)

    now = new Date(now.getTime() + 25 * 60 * 60_000)
    expect(await drainOnce(deps())).toMatchObject({submitted: 1, rateLimited: false})
  })

  it('spaces submissions apart within a tick', async () => {
    const fake = makeService()
    buildRepo(fake)
    await configure()
    await seedSource()
    await queue('https://example.com/a', 'https://example.com/b', 'https://example.com/c')

    const sleep = vi.fn(async () => {})
    await drainOnce({...deps(), sleep})
    // One gap between each pair, none before the first.
    expect(sleep).toHaveBeenCalledTimes(2)
  })
})

describe('volume notification', () => {
  it('warns once per hour when submissions cross the threshold', async () => {
    const fake = makeService()
    buildRepo(fake)
    await configure({notifyThreshold: 2, hourlyLimit: 100})
    await seedSource()
    await queue('https://example.com/a', 'https://example.com/b', 'https://example.com/c')

    // Below the threshold on the first tick: two submitted, nothing said.
    await drainOnce(deps())
    expect(notices).toEqual([])

    now = new Date(now.getTime() + 60_000)
    await drainOnce(deps())
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('submitted in the last hour')

    // Same hour bucket — not repeated on every tick.
    now = new Date(now.getTime() + 60_000)
    await drainOnce(deps())
    expect(notices).toHaveLength(1)
  })

  it('stays quiet when the threshold is disabled', async () => {
    const fake = makeService()
    buildRepo(fake)
    await configure({notifyThreshold: 0})
    await seedSource()
    await queue('https://example.com/a', 'https://example.com/b')

    await drainOnce(deps())
    now = new Date(now.getTime() + 60_000)
    await drainOnce(deps())
    expect(notices).toEqual([])
  })
})
