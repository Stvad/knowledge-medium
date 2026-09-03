// @vitest-environment node
/**
 * Startup-metrics persistence: the pure timeline→record fold, the block-per-session
 * write, and the synced→drained→settled collector orchestration.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { getPluginUIStateBlock, getPluginUIStateChild } from '@/data/stateBlocks'
import { getClientId, resetClientIdCache } from '@/utils/clientId'
import { observeWorkspace } from '@/plugins/interaction-metrics/sessionContext'
import { jsonPathForProperty } from '@/data/internals/typedBlockQuery'
import type { User } from '@/data/api'
import { definitionSeedsFacet, typeSeedsFacet } from '@/data/facets'
import type { FacetRuntime } from '@/facets/facet'
import {
  buildStartupRecord,
  collectStartupMetricsEffect,
  resetStartupMetricsRecorded,
  whenBootRecordSettled,
  SETTLE_FALLBACK_MS,
  startupMetricsUIStateType,
  startupRecordProp,
  startupRecordType,
  WRITE_RETRY_MS,
  writeStartupRecord,
} from '../record'
import {
  getStartupTimeline,
  markStartup,
  markStartupAt,
  resetStartupTimeline,
  startStartupObservers,
} from '@/utils/startupTimeline.js'

const WS = 'ws-1'
const USER: User = { id: 'user-1', name: 'Alice' }

let sharedDb: TestDb
let repo: Repo


beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  resetStartupTimeline()
  resetStartupMetricsRecorded()
  resetClientIdCache()
  repo = createTestRepo({
    db: sharedDb.db,
    user: USER,
    extensions: [
      definitionSeedsFacet.of(startupRecordProp, {source: 'test'}),
      typeSeedsFacet.of(startupRecordType, {source: 'test'}),
    ],
  }).repo
  repo.setActiveWorkspaceId(WS)
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('buildStartupRecord', () => {
  it('folds the marks into ms-since-boot fields, leaving unreached phases absent', () => {
    const record = buildStartupRecord(
      { timeOriginMs: 1000, marks: { repoReady: 50, firstContentPaint: 120, interactive: 300 } },
      { recordedAt: 1700, appVersion: '2026.06.23', appSha: 'abc123', clientId: 'client-9', deviceLabel: 'installed:MacIntel' },
    )
    expect(record).toEqual({
      recordedAt: 1700,
      appVersion: '2026.06.23',
      appSha: 'abc123',
      clientId: 'client-9',
      deviceLabel: 'installed:MacIntel',
      timeOriginMs: 1000,
      repoReadyMs: 50,
      workspaceResolvedMs: undefined,
      bootstrapDoneMs: undefined,
      firstContentPaintMs: 120,
      syncedMs: undefined,
      drainedMs: undefined,
      interactiveMs: 300,
    })
  })
})

describe('writeStartupRecord', () => {
  // Records nest under a per-client group block, not directly under the
  // per-user startup-metrics root; resolve the same group the writer uses.
  const resolveGroup = async (): Promise<{ root: string; group: string }> => {
    const root = await getPluginUIStateBlock(repo, WS, USER, startupMetricsUIStateType)
    const group = await getPluginUIStateChild(root, getClientId())
    return { root: root.id, group: group.id }
  }

  it('appends a record as a fresh child block under this client\'s group block', async () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(50).mockReturnValueOnce(120)
    markStartup('repoReady')        // 50
    markStartup('firstContentPaint') // 120
    vi.spyOn(Date, 'now').mockReturnValue(1700)

    const id = await writeStartupRecord(repo, WS)

    const { group } = await resolveGroup()
    const row = await sharedDb.db.getOptional<{ parent_id: string }>(
      'SELECT parent_id FROM blocks WHERE id = ?',
      [id],
    )
    expect(row?.parent_id).toBe(group)

    const block = repo.block(id!)
    await block.load()
    expect(block.peekProperty(startupRecordProp)).toMatchObject({
      recordedAt: 1700,
      firstContentPaintMs: 120,
      repoReadyMs: 50,
      clientId: getClientId(),
    })
  })

  it('groups records under a per-client block with nothing to index', async () => {
    await writeStartupRecord(repo, WS)
    const { root, group } = await resolveGroup()
    // The group hangs off the per-user root, not the record directly.
    const groupRow = await sharedDb.db.getOptional<{ parent_id: string; content: string }>(
      'SELECT parent_id, content FROM blocks WHERE id = ?',
      [group],
    )
    expect(groupRow?.parent_id).toBe(root)
    // Identified by its derived id, never a title: content is FTS-indexed and
    // listed by every block-discovery surface. Asserted as EXACTLY empty — the
    // previous version checked that the content CONTAINED the client-id prefix,
    // which a bare client-UUID title also satisfies, so it went on passing when
    // the device label was replaced by the UUID and the row stayed indexed.
    expect(groupRow?.content).toBe('')
  })

  it('two distinct clients land under two distinct group blocks', async () => {
    // First client.
    resetClientIdCache()
    const clientA = getClientId()
    const recA = await writeStartupRecord(repo, WS)
    // Second client: a fresh id (no localStorage in node ⇒ a new uuid is minted)
    // stands in for a different browser/device.
    resetClientIdCache()
    const clientB = getClientId()
    expect(clientB).not.toBe(clientA)
    const recB = await writeStartupRecord(repo, WS)

    const root = await getPluginUIStateBlock(repo, WS, USER, startupMetricsUIStateType)
    // Exactly two group blocks hang off the per-user root — one per client.
    const groups = await sharedDb.db.getAll<{ id: string }>(
      'SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0',
      [root.id],
    )
    expect(groups).toHaveLength(2)

    // Each client's record nests under its OWN group (distinct ids).
    const groupA = await getPluginUIStateChild(root, clientA)
    const groupB = await getPluginUIStateChild(root, clientB)
    expect(groupA.id).not.toBe(groupB.id)
    const parentOf = async (id: string): Promise<string | undefined> =>
      (await sharedDb.db.getOptional<{ parent_id: string }>(
        'SELECT parent_id FROM blocks WHERE id = ?', [id],
      ))?.parent_id
    expect(await parentOf(recA!)).toBe(groupA.id)
    expect(await parentOf(recB!)).toBe(groupB.id)
  })

  it('block-per-session: two writes create two distinct records (no clobber)', async () => {
    const first = await writeStartupRecord(repo, WS)
    const second = await writeStartupRecord(repo, WS)
    expect(first).not.toBe(second)
    const { group } = await resolveGroup()
    const children = await sharedDb.db.getAll<{ id: string }>(
      'SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0',
      [group],
    )
    expect(children.map(c => c.id).sort()).toEqual([first, second].sort())
  })

  it('orders records newest-first (reverse chronological) by prepending', async () => {
    const first = await writeStartupRecord(repo, WS)
    const second = await writeStartupRecord(repo, WS)
    const third = await writeStartupRecord(repo, WS)
    const { group } = await resolveGroup()
    // Same (order_key, id) ordering the block tree uses.
    const ordered = await sharedDb.db.getAll<{ id: string }>(
      'SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id',
      [group],
    )
    expect(ordered.map(c => c.id)).toEqual([third, second, first])
  })

  // The flag itself is set once, by the shared record owner; what this pins is
  // that the startup path still goes through it rather than opening its own
  // transaction. Measured across the SECOND write: the first also mints this
  // client's containers, which are deliberately counted as ordinary work.
  it('leaves the non-telemetry counters alone', async () => {
    await writeStartupRecord(repo, WS)
    const before = repo.metrics().excludingTelemetry

    await writeStartupRecord(repo, WS)

    const after = repo.metrics().excludingTelemetry
    expect(after.writes).toBe(before.writes)
    expect(after.handleStore).toEqual(before.handleStore)
  })

  it('writes nothing in a read-only workspace', async () => {
    // Automation scope is admitted locally and refused by the server's RLS,
    // landing in the rejection quarantine the status chip surfaces.
    repo.setReadOnly(true)
    const tx = vi.spyOn(repo, 'tx')
    expect(await writeStartupRecord(repo, WS)).toBeNull()
    expect(tx).not.toHaveBeenCalled()
  })
})

describe('collectStartupMetricsEffect', () => {
  // Effects run timers/listeners until they record; dispose them between tests
  // so a still-polling effect can't fire once a later test marks firstContentPaint.
  const effectCleanups: Array<() => void> = []
  afterEach(() => { for (const c of effectCleanups.splice(0)) c() })

  /** Returns the disposer the effect handed back — `undefined` means it
   *  declined to arm anything, which is the only synchronous evidence the
   *  once-per-session gate produced. */
  const startEffect = (workspaceId: string): (() => void) | undefined => {
    const cleanup = collectStartupMetricsEffect.start({
      repo,
      workspaceId,
      runtime: {} as FacetRuntime,
      safeMode: false,
    })
    if (typeof cleanup !== 'function') return undefined
    effectCleanups.push(cleanup)
    return cleanup
  }

  const countRecords = async (): Promise<number> => {
    const root = await getPluginUIStateBlock(repo, WS, USER, startupMetricsUIStateType)
    // Records nest one level down, under per-client group blocks — count the
    // grandchildren (no side-effect group creation).
    const rows = await sharedDb.db.getAll<{ n: number }>(
      `SELECT count(*) AS n FROM blocks
       WHERE deleted = 0
         AND parent_id IN (SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0)`,
      [root.id],
    )
    return rows[0]?.n ?? 0
  }

  // By the time the deferred write runs, `record()` has torn down every timer
  // and listener, so a write that FAILS has no path back unless it owns one —
  // and a rejection is as transient as a decline.
  // A plugin toggle can restart this effect while the previous instance's write
  // is still running. At that instant `recorded` is still false, so it cannot
  // be the only guard — two records for one boot would both match the
  // current-boot check and take two of the three recent-window slots.
  it('does not write twice when restarted while a write is in flight', async () => {
    const realTx = repo.tx.bind(repo)
    let release: (() => void) | undefined
    const held = new Promise<void>((r) => { release = r })
    let seen = 0
    vi.spyOn(repo, 'tx').mockImplementation(async (fn, opts) => {
      if (opts?.description === 'startup metrics record' && seen++ === 0) await held
      return realTx(fn, opts)
    })

    markStartup('firstContentPaint')
    startEffect(WS)
    await vi.waitFor(() => expect(seen).toBeGreaterThan(0))
    // The toggle: a second collector starts before the first write lands.
    startEffect(WS)
    release!()

    await vi.waitFor(async () => expect(await countRecords()).toBe(1))
    // Assert the CAUSE, not elapsed-time absence: the second collector must
    // never have entered the write at all, which a sleep could only ever
    // suggest. `seen` counts record transactions.
    expect(seen).toBe(1)
    // Measured standalone at ~110ms, so the default would cover even the ~6x
    // the gate's contention adds. The budget is raised for the INNER waits:
    // this drives fake timers through a retry, and a `vi.waitFor` that could
    // outlive its enclosing test can never report which assertion never
    // settled — "timed out in 5000ms" with no clue why.
  }, 20_000)

  it('retries a write that rejects', async () => {
    const realTx = repo.tx.bind(repo)
    let failures = 0
    vi.spyOn(repo, 'tx').mockImplementation(async (fn, opts) => {
      if (opts?.description === 'startup metrics record' && failures === 0) {
        failures++
        throw new Error('transient database failure')
      }
      return realTx(fn, opts)
    })

    // The retry sits behind a 30s production timer, advanced rather than waited
    // out. Installed BEFORE the effect: `useFakeTimers` swaps the global timer
    // functions and does not adopt timers already scheduled, so arming it after
    // the first failure would leave the retry pending on the real clock.
    // `shouldAdvanceTime` keeps the database's own async work progressing.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    markStartup('firstContentPaint')
    startEffect(WS)
    // `waitFor` advances the mocked clock itself, which the first attempt needs:
    // its deferrals are timers but the database work between them is real I/O
    // that a bare `advanceTimersByTime` returns without waiting for.
    await vi.waitFor(() => expect(failures).toBe(1))
    expect(await countRecords()).toBe(0)

    await vi.advanceTimersByTimeAsync(WRITE_RETRY_MS + 500)
    vi.useRealTimers()
    await vi.waitFor(async () => expect(await countRecords()).toBe(1))
    // ~110ms standalone; raised for the same reason as above — the inner waits
    // must stay strictly below the enclosing budget to be able to report.
  }, 20_000)

  it('marks interactive after first paint and persists exactly one record', async () => {
    markStartup('firstContentPaint')
    startEffect(WS)
    // No Long Tasks API under node ⇒ the interactive detector takes the
    // idle-frame fallback (setTimeout(0)), marks interactive, and writes.
    await vi.waitFor(async () => expect(await countRecords()).toBe(1))
    expect(getStartupTimeline().marks.interactive).toBeDefined()
    // A reader fences its first sample on this; a record that landed must not
    // leave it waiting out the timeout.
    await expect(whenBootRecordSettled(60_000)).resolves.toBeUndefined()
  })

  // Asserted on the RECORD, not on a count or an elapsed window. Counting cannot
  // pin this: with the gate deleted the pre-paint write lands, sets the
  // once-per-boot flag, and the run still ends with exactly one record — the
  // only difference is WHEN it was taken. The stored `firstContentPaintMs` is
  // that difference, and it is durable rather than a race.
  it('does not record before first paint (no firstContentPaint mark)', async () => {
    // A real pre-paint window, driven rather than slept through: far past the
    // 250ms paint re-poll and every idle hop the write path uses, and short of
    // the settle fallback, which is meant to record without paint. A write that
    // starts in here builds its record from a timeline with no paint mark, and
    // that lands in the stored row whenever the transaction finishes.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    startEffect(WS)
    await vi.advanceTimersByTimeAsync(SETTLE_FALLBACK_MS / 2)

    // Paint is marked while the clock is still mocked: switching back first
    // would discard the effect's pending re-poll timer and leave it inert.
    markStartup('firstContentPaint')
    await vi.advanceTimersByTimeAsync(1_000)
    vi.useRealTimers()
    await vi.waitFor(async () => expect(await countRecords()).toBe(1))

    const rows = await sharedDb.db.getAll<{ properties_json: string }>(
      `SELECT properties_json FROM blocks
       WHERE deleted = 0 AND json_extract(properties_json, ?) IS NOT NULL`,
      [jsonPathForProperty(startupRecordProp.name)],
    )
    expect(rows).toHaveLength(1)
    const record = JSON.parse(rows[0].properties_json)[startupRecordProp.name]
    expect(record.firstContentPaintMs).toBeDefined()
  })

  // Boot happens once and the marks are boot-relative, so a restart — a plugin
  // toggle, a workspace switch — must not log a second startup.
  //
  // The timeline is page-global — it measures loading THIS workspace's graph —
  // so a switch before the first write lands must not let the replacement
  // instance file these timings as the new workspace's history. It would pass
  // the once-per-session guard, which is still false at that moment.
  //
  // Asserted on the cause: the replacement arms nothing, so it returns no
  // disposer. Declining is the safe direction — one boot unrecorded, against a
  // baseline permanently skewed by another graph's load.
  it('declines to record this boot into a workspace it did not happen in', () => {
    markStartup('firstContentPaint')
    expect(startEffect(WS)).toBeTypeOf('function')
    expect(startEffect('ws-2')).toBeUndefined()
  })

  // A reader fences its first sample on the settle. A collector that declines
  // to arm is never going to write, so it has to say so — otherwise that reader
  // waits out a cap measured for a writer that is actually working.
  it('settles when the collector is torn down before it writes', async () => {
    markStartup('firstContentPaint')
    const stop = startEffect(WS)
    expect(stop).toBeTypeOf('function')

    stop?.()

    await expect(whenBootRecordSettled(60_000)).resolves.toBeUndefined()
  })

  // Teardown does not cancel a write already in flight, and that write can
  // still commit — so announcing "over" would send a reader to sample the
  // series moments before the row lands.
  it('leaves the signal outstanding while a write is still in flight', async () => {
    const realTx = repo.tx.bind(repo)
    let release = (): void => {}
    const held = new Promise<void>((r) => { release = r })
    vi.spyOn(repo, 'tx').mockImplementation(async (fn, opts) => {
      if (opts?.description === 'startup metrics record') await held
      return realTx(fn, opts)
    })

    markStartup('firstContentPaint')
    const stop = startEffect(WS)
    // Fence on the write having STARTED, not on a duration.
    await vi.waitFor(() => expect(repo.tx).toHaveBeenCalled())

    stop?.()
    let settled = false
    void whenBootRecordSettled(60_000).then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    // ...and the write's own completion is what settles it.
    release()
    await vi.waitFor(() => expect(settled).toBe(true))
  }, 20_000)

  it('settles immediately when it declines to arm', async () => {
    // NOTHING else armed: a collector that starts normally settles the signal
    // by writing, which would hide whether the declining path settles at all.
    expect(startEffect('')).toBeUndefined()

    // Resolves without the timeout being reached — left outstanding, this hangs
    // until the test times out rather than returning.
    await expect(whenBootRecordSettled(60_000)).resolves.toBeUndefined()
  })

  // This plugin is independently disableable, so a page can boot in one
  // workspace with recording off, move to another, and be switched on there.
  // The origin is claimed by the always-on observe effect rather than by this
  // one, so being enabled later cannot make the workspace it was enabled in the
  // boot's origin — which would file the first workspace's load as the second's.
  it('declines when the page booted somewhere this effect never ran', () => {
    markStartup('firstContentPaint')
    observeWorkspace(repo, 'ws-booted-in')
    expect(startEffect(WS)).toBeUndefined()
  })

  // The Repo as well as the workspace. A local sign-out swaps it without a
  // reload, so the next user opening the SAME shared workspace satisfies a
  // workspace-only pin and would receive the previous user's boot.
  it('declines to record this boot into a Repo it did not happen in', async () => {
    markStartup('firstContentPaint')
    expect(startEffect(WS)).toBeTypeOf('function')

    const other = createTestRepo({ db: sharedDb.db, user: USER }).repo
    other.setActiveWorkspaceId(WS)
    expect(await collectStartupMetricsEffect.start({ repo: other, workspaceId: WS } as Parameters<
      typeof collectStartupMetricsEffect.start
    >[0])).toBeUndefined()
  })

  // Asserted on the CAUSE: once the write has settled, the restart arms
  // nothing, so it returns no disposer. A count cannot pin this — it is already
  // 1, so both a bare assertion and a `waitFor` on it pass on the first tick
  // while the duplicate write is still several idle hops and awaits away.
  //
  // But the ROW is not that precondition either. `appendClientRecord` resolves
  // only after its retention pass, and the flag the restart consults is set on
  // that resolution — so between "one row exists" and "a restart is refused"
  // there is a whole extra query, and under gate load (one worker per core)
  // that gap is wide enough to lose. A restart INSIDE it legitimately arms; the
  // recorder's own `recording` guard is what stops it writing, and the effect's
  // comment says so. Retry until the write has settled, disposing whatever an
  // attempt arms so no attempt can leave a live instance behind.
  it('records at most once per session even if the effect restarts', async () => {
    markStartup('firstContentPaint')
    expect(startEffect(WS)).toBeTypeOf('function')
    await vi.waitFor(async () => expect(await countRecords()).toBe(1), { timeout: 5_000 })

    await vi.waitFor(() => {
      const stop = startEffect(WS)
      stop?.()
      expect(stop).toBeUndefined()
    }, { timeout: 5_000 })

    // The invariant the whole test is for, restated against the graph.
    expect(await countRecords()).toBe(1)
    // ~55ms standalone. Raised because the two `vi.waitFor` budgets above are
    // 5s each, which is the default test timeout — an inner wait that cannot
    // expire before its test reports "timed out" and names nothing.
  }, 20_000)

  it('debounces interactive off long-task events when the Long Tasks API is present', () => {
    vi.useFakeTimers()
    let observerCb: ((list: { getEntries: () => Array<{ startTime: number; duration: number }> }) => void) | undefined
    class FakePerformanceObserver {
      constructor(cb: typeof observerCb) { observerCb = cb }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('PerformanceObserver', FakePerformanceObserver)
    startStartupObservers() // longTasksSupported() now true → debounce path, not the idle fallback
    try {
      markStartupAt('firstContentPaint', 100)
      startEffect(WS)
      // A long task ending at 500 resets the quiet window.
      observerCb?.({ getEntries: () => [{ startTime: 200, duration: 300 }] })
      vi.advanceTimersByTime(1999)
      expect(getStartupTimeline().marks.interactive).toBeUndefined() // window not yet elapsed
      vi.advanceTimersByTime(1) // 2s of quiet since the last long task
      // interactive lands at the END of the last long task (500), not "now" (2000).
      expect(getStartupTimeline().marks.interactive).toBe(500)
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
})

/**
 * The settle signal a reader fences its first sample on.
 *
 * Sampling the startup series before this boot's record attempt is over cannot
 * tell "not written yet" from "recorder switched off", and reports the latter.
 */
describe('whenBootRecordSettled', () => {
  it('waits while a record attempt is still outstanding', async () => {
    let settled = false
    void whenBootRecordSettled(60_000).then(() => { settled = true })
    await Promise.resolve()

    expect(settled).toBe(false)
  })

  // A recorder that never runs — toggle off, or the page booted elsewhere —
  // settles nothing, so the wait has to end on its own.
  it('gives up after the timeout when nothing ever settles', async () => {
    vi.useFakeTimers()
    try {
      let settled = false
      void whenBootRecordSettled(5_000).then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(5_001)
      expect(settled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
    // ...and having given up once, a later caller does not wait again.
    await expect(whenBootRecordSettled(60_000)).resolves.toBeUndefined()
  })
})

