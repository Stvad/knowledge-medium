// @vitest-environment node
/**
 * Startup-metrics persistence: the pure timeline→record fold, the block-per-session
 * write, and the synced→drained→settled collector orchestration.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BlockCache } from '@/data/blockCache'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { getPluginUIStateBlock } from '@/data/stateBlocks'
import type { User } from '@/data/api'
import type { FacetRuntime } from '@/facets/facet'
import {
  buildStartupRecord,
  collectStartupMetricsEffect,
  onFirstSync,
  resetStartupMetricsRecorded,
  startupMetricsUIStateType,
  startupRecordProp,
  writeStartupRecord,
} from '../record'
import {
  getStartupTimeline,
  markStartup,
  resetStartupTimeline,
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
      { recordedAt: 1700, appVersion: '2026.06.23', appSha: 'abc123', deviceLabel: 'installed:MacIntel' },
    )
    expect(record).toEqual({
      recordedAt: 1700,
      appVersion: '2026.06.23',
      appSha: 'abc123',
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
  it('appends a record as a fresh child block under the per-user startup-metrics block', async () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(50).mockReturnValueOnce(120)
    markStartup('repoReady')        // 50
    markStartup('firstContentPaint') // 120
    vi.spyOn(Date, 'now').mockReturnValue(1700)

    const id = await writeStartupRecord(repo, WS)

    const parent = await getPluginUIStateBlock(repo, WS, USER, startupMetricsUIStateType)
    const row = await sharedDb.db.getOptional<{ parent_id: string }>(
      'SELECT parent_id FROM blocks WHERE id = ?',
      [id],
    )
    expect(row?.parent_id).toBe(parent.id)

    const block = repo.block(id)
    await block.load()
    expect(block.peekProperty(startupRecordProp)).toMatchObject({
      recordedAt: 1700,
      firstContentPaintMs: 120,
      repoReadyMs: 50,
    })
    // Content is the ISO timestamp so the entry is legible in the tree.
    const contentRow = await sharedDb.db.getOptional<{ content: string }>(
      'SELECT content FROM blocks WHERE id = ?',
      [id],
    )
    expect(contentRow?.content).toBe(new Date(1700).toISOString())
  })

  it('block-per-session: two writes create two distinct records (no clobber)', async () => {
    const first = await writeStartupRecord(repo, WS)
    const second = await writeStartupRecord(repo, WS)
    expect(first).not.toBe(second)
    const parent = await getPluginUIStateBlock(repo, WS, USER, startupMetricsUIStateType)
    const children = await sharedDb.db.getAll<{ id: string }>(
      'SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0',
      [parent.id],
    )
    expect(children.map(c => c.id).sort()).toEqual([first, second].sort())
  })

  it('orders records newest-first (reverse chronological) by prepending', async () => {
    const first = await writeStartupRecord(repo, WS)
    const second = await writeStartupRecord(repo, WS)
    const third = await writeStartupRecord(repo, WS)
    const parent = await getPluginUIStateBlock(repo, WS, USER, startupMetricsUIStateType)
    // Same (order_key, id) ordering the block tree uses.
    const ordered = await sharedDb.db.getAll<{ id: string }>(
      'SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id',
      [parent.id],
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
    const parent = await getPluginUIStateBlock(repo, WS, USER, startupMetricsUIStateType)
    const rows = await sharedDb.db.getAll<{ n: number }>(
      'SELECT count(*) AS n FROM blocks WHERE parent_id = ? AND deleted = 0',
      [parent.id],
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
})

describe('onFirstSync', () => {
  it('fires immediately when the workspace is already synced', () => {
    const cb = vi.fn()
    onFirstSync({ currentStatus: { hasSynced: true } }, cb)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('fires immediately when there is no sync layer (local-only)', () => {
    const cb = vi.fn()
    onFirstSync({}, cb)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('waits for the synced status change, then disposes its listener', () => {
    let listener: { statusChanged?: (s: { hasSynced?: boolean | null }) => void } | undefined
    let disposed = false
    const db = {
      currentStatus: { hasSynced: false },
      registerListener: (l: typeof listener) => { listener = l; return () => { disposed = true } },
    }
    const cb = vi.fn()
    onFirstSync(db, cb)
    expect(cb).not.toHaveBeenCalled()
    listener?.statusChanged?.({ hasSynced: false }) // intermediate tick — still nothing
    expect(cb).not.toHaveBeenCalled()
    listener?.statusChanged?.({ hasSynced: true })
    expect(cb).toHaveBeenCalledTimes(1)
    expect(disposed).toBe(true)
  })
})
