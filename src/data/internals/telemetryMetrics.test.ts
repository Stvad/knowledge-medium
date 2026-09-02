// @vitest-environment node
/**
 * `repo.metrics().excludingTelemetry` — the counters a feature that reports
 * performance figures should read, with the app's own self-measurement left
 * out.
 *
 * The point of counting here rather than letting such a feature subtract its
 * own activity from the totals: the delta is taken inside the same synchronous
 * block as the invalidation walk it counts, so nothing else can land in it. A
 * consumer's own before/after window necessarily spans its awaits.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { ChangeScope, type User } from '@/data/api'

const WS = 'ws-1'
const USER: User = { id: 'user-1', name: 'Alice' }

let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({ db: sharedDb.db, user: USER }).repo
  repo.setActiveWorkspaceId(WS)
})

let n = 0
const write = (telemetry: boolean) =>
  repo.tx(async (tx) => {
    await tx.create({
      id: `b-${n++}`, workspaceId: WS, parentId: null, orderKey: `a${n}`,
      content: 'x', properties: {},
    }, { systemMint: true })
  }, { scope: ChangeScope.Automation, telemetry, description: 'probe' })

describe('metrics().excludingTelemetry', () => {
  it('counts an ordinary transaction and the fan-out it causes', async () => {
    const handle = repo.query.recentBlocks({ workspaceId: WS })
    handle.subscribe(() => {})
    await handle.load()

    const before = repo.metrics()
    await write(false)
    const after = repo.metrics()

    expect(after.excludingTelemetry.writes).toBe(before.excludingTelemetry.writes + 1)
    // The mounted workspace-wide handle really is invalidated by a create — a
    // live-set membership change fires `kernel.content` — which is exactly why
    // a self-measuring feature must not have its own creates counted.
    const caused = (after.excludingTelemetry.handleStore.loaderInvalidations ?? 0)
      - (before.excludingTelemetry.handleStore.loaderInvalidations ?? 0)
    expect(caused).toBeGreaterThan(0)
  })

  it('counts neither the write nor the fan-out of a telemetry transaction', async () => {
    const handle = repo.query.recentBlocks({ workspaceId: WS })
    handle.subscribe(() => {})
    await handle.load()

    const before = repo.metrics()
    await write(true)
    const after = repo.metrics()

    expect(after.excludingTelemetry.writes).toBe(before.excludingTelemetry.writes)
    expect(after.excludingTelemetry.handleStore).toEqual(before.excludingTelemetry.handleStore)
    // The TOTALS still moved — a telemetry write is a real write that really
    // invalidates; it is only kept off the side a reporter reads.
    expect(after.handleStore.loaderInvalidations)
      .toBeGreaterThan(before.handleStore.loaderInvalidations)
  })

  it('does not count a transaction that rolled back', async () => {
    const before = repo.metrics().excludingTelemetry.writes
    await expect(repo.tx(async () => { throw new Error('rollback') },
      { scope: ChangeScope.Automation, description: 'probe' })).rejects.toThrow('rollback')
    expect(repo.metrics().excludingTelemetry.writes).toBe(before)
  })

  // Idempotent ensures commit empty routinely (`stateBlocks.ts` returns early
  // when the row is already right). Each one would add 1 to the denominator and
  // 0 to the numerator of a resolves-per-write ratio, so a release that adds a
  // hot ensure would look like a fan-out improvement.
  it('does not count a committed transaction that changed no row', async () => {
    const before = repo.metrics().excludingTelemetry
    await repo.tx(async () => { /* commits, writes nothing */ },
      { scope: ChangeScope.Automation, description: 'empty' })
    const after = repo.metrics().excludingTelemetry
    expect(after.writes).toBe(before.writes)
    expect(after.handleStore).toEqual(before.handleStore)
  })

  // The delta window is the synchronous invalidation walk, so counters bumped
  // from a loader's settle path can never move inside it. Reporting them as 0
  // would be a measurement that never happened claiming a clean result — and
  // this map is persisted and compared against later sessions.
  it('omits settle-path counters rather than storing them as zero', async () => {
    const handle = repo.query.recentBlocks({ workspaceId: WS })
    handle.subscribe(() => {})
    await handle.load()
    await write(false)

    const fanout = repo.metrics().excludingTelemetry.handleStore
    // The walk's own counters are there...
    expect(fanout.invalidations).toBeGreaterThan(0)
    expect(fanout.handlesWalked).toBeGreaterThan(0)
    // ...and the ones it cannot attribute are absent, not 0.
    expect('notifiesFired' in fanout).toBe(false)
    expect('reloadsAfterSettle' in fanout).toBe(false)
    // The TOTALS do carry them, so this is a scoping decision, not a lost count.
    await vi.waitFor(() => expect(repo.metrics().handleStore.notifiesFired).toBeGreaterThan(0))
  })

  // A consumer holding figures from before a reset needs to know they are from
  // a span the counters no longer cover. Inferring it from a counter going
  // backwards fails once other writes have carried it back up.
  it('bumps the epoch and zeroes the pair on reset', async () => {
    await write(false)
    const before = repo.metrics()
    expect(before.excludingTelemetry.writes).toBeGreaterThan(0)

    repo.resetMetrics()

    const after = repo.metrics()
    expect(after.epoch).toBe(before.epoch + 1)
    expect(after.excludingTelemetry.writes).toBe(0)
    expect(after.excludingTelemetry.handleStore).toEqual({})
    // The span's origin moves with it: a consumer reporting a duration beside
    // these counters must not describe a window containing work they dropped.
    expect(after.epochWorkspaceId).toBe(WS)
    expect(after.epochStartedAt).toBeGreaterThanOrEqual(before.epochStartedAt)
  })
})
