// @vitest-environment node
/**
 * Startup-metrics persistence: the pure timeline→record fold, the block-per-session
 * write, and the synced→drained→settled collector orchestration.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BlockCache } from '@/data/blockCache'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { getPluginUIStateBlock, getPluginUIStateChild } from '@/data/stateBlocks'
import { getClientId, resetClientIdCache } from '@/utils/clientId'
import type { User } from '@/data/api'
import type { FacetRuntime } from '@/facets/facet'
import {
  buildStartupRecord,
  collectStartupMetricsEffect,
  resetStartupMetricsRecorded,
  startupMetricsUIStateType,
  startupRecordProp,
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
let txSeq = 0

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  resetStartupTimeline()
  resetStartupMetricsRecorded()
  resetClientIdCache()
  txSeq = 0
  repo = new Repo({ db: sharedDb.db, cache: new BlockCache(), user: USER, newTxSeq: () => ++txSeq })
  repo.setActiveWorkspaceId(WS)
})
afterEach(() => {
  repo.stopSyncObserver()
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

    const block = repo.block(id)
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
})

describe('collectStartupMetricsEffect', () => {
  // Effects run timers/listeners until they record; dispose them between tests
  // so a still-polling effect can't fire once a later test marks firstContentPaint.
  const effectCleanups: Array<() => void> = []
  afterEach(() => { for (const c of effectCleanups.splice(0)) c() })

  const startEffect = (workspaceId: string): void => {
    const cleanup = collectStartupMetricsEffect.start({
      repo,
      workspaceId,
      runtime: {} as FacetRuntime,
      safeMode: false,
    })
    if (typeof cleanup === 'function') effectCleanups.push(cleanup)
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

  it('marks interactive after first paint and persists exactly one record', async () => {
    markStartup('firstContentPaint')
    startEffect(WS)
    // No Long Tasks API under node ⇒ the interactive detector takes the
    // idle-frame fallback (setTimeout(0)), marks interactive, and writes.
    await vi.waitFor(async () => expect(await countRecords()).toBe(1))
    expect(getStartupTimeline().marks.interactive).toBeDefined()
  })

  it('does not record before first paint (no firstContentPaint mark)', async () => {
    startEffect(WS)
    // Interactive detection re-polls for the paint mark; nothing is written.
    await new Promise(r => setTimeout(r, 50))
    expect(await countRecords()).toBe(0)
  })

  it('records at most once per session even if the effect restarts', async () => {
    markStartup('firstContentPaint')
    startEffect(WS)
    await vi.waitFor(async () => expect(await countRecords()).toBe(1))
    // A second workspace open in the same session must not log a second startup.
    startEffect('ws-2')
    await new Promise(r => setTimeout(r, 0))
    expect(await countRecords()).toBe(1)
  })

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
