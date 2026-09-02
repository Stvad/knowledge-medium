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
import { jsonPathForProperty } from '@/data/internals/typedBlockQuery'
import type { User } from '@/data/api'
import { definitionSeedsFacet, typeSeedsFacet } from '@/data/facets'
import type { FacetRuntime } from '@/facets/facet'
import {
  buildStartupRecord,
  collectStartupMetricsEffect,
  resetStartupMetricsRecorded,
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
    // Content is the ISO timestamp so the entry is legible in the tree.
    const contentRow = await sharedDb.db.getOptional<{ content: string }>(
      'SELECT content FROM blocks WHERE id = ?',
      [id],
    )
    expect(contentRow?.content).toBe(new Date(1700).toISOString())
  })

  it('groups records under a per-client block (child of the root, titled with the device label)', async () => {
    await writeStartupRecord(repo, WS)
    const { root, group } = await resolveGroup()
    // The group hangs off the per-user root, not the record directly.
    const groupRow = await sharedDb.db.getOptional<{ parent_id: string; content: string }>(
      'SELECT parent_id, content FROM blocks WHERE id = ?',
      [group],
    )
    expect(groupRow?.parent_id).toBe(root)
    // Title carries the short client-id suffix so peers on the same platform
    // string stay distinguishable.
    expect(groupRow?.content).toContain(getClientId().slice(0, 8))
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
  }, 20_000)

  it('marks interactive after first paint and persists exactly one record', async () => {
    markStartup('firstContentPaint')
    startEffect(WS)
    // No Long Tasks API under node ⇒ the interactive detector takes the
    // idle-frame fallback (setTimeout(0)), marks interactive, and writes.
    await vi.waitFor(async () => expect(await countRecords()).toBe(1))
    expect(getStartupTimeline().marks.interactive).toBeDefined()
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
