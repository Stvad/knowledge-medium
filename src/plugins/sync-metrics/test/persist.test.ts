// @vitest-environment node
/** A drain event through the real collector into a real persisted record block. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { definitionSeedsFacet, typeSeedsFacet } from '@/data/facets'
import type { Repo } from '@/data/repo'
import type { SyncDrainStats } from '@/data/internals/syncObserver/observer'
import { startSyncMetricsCollector } from '../collect'
import * as record from '../record'
import { syncMetricsRecordProp, syncMetricsRecordType } from '../record'

const WS = 'ws-1'
const LIKE = '%sync-metrics:record%'
let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({
    db: sharedDb.db,
    user: { id: 'user-1', name: 'Alice' },
    extensions: [
      definitionSeedsFacet.of(syncMetricsRecordProp, { source: 'test' }),
      typeSeedsFacet.of(syncMetricsRecordType, { source: 'test' }),
    ],
  }).repo
  repo.setActiveWorkspaceId(WS)
})

const drainStats = (over: Partial<SyncDrainStats>): SyncDrainStats => ({
  source: 'queue', completed: true, endedAtMs: 1000, wallMs: 20, windows: 1, rows: 5,
  applied: 5, deferred: 0, skippedStale: 0, quarantined: 0, deleted: 0,
  readMs: 1, decodeMs: 1, writeMs: 1, invalidateMs: 1, bookkeepingMs: 1, ...over,
})

describe('sync-metrics persistence', () => {
  // Real-DB round trip; the 5000ms inner poll needs a larger enclosing budget.
  it('persists a qualifying drain as a typed record block', async () => {
    let emit!: (s: SyncDrainStats) => void
    vi.spyOn(repo, 'onSyncDrainStats').mockImplementation((cb) => { emit = cb; return () => {} })
    // The collector takes its writer by injection; route it to the real one.
    startSyncMetricsCollector(repo, WS, {
      write: (r, w, d) => record.writeSyncMetricsRecord(r, w, d),
      takeDownload: () => null,
    })

    emit(drainStats({ rows: 4000, wallMs: 1500.4 }))
    await vi.waitFor(async () => {
      const rows = await sharedDb.db.getAll<{ id: string }>(
        'SELECT id FROM blocks WHERE properties_json LIKE ?', [LIKE])
      expect(rows).toHaveLength(1)
    }, { timeout: 5000 })

    const [row] = await sharedDb.db.getAll<{ id: string }>(
      'SELECT id FROM blocks WHERE properties_json LIKE ?', [LIKE])
    const block = repo.block(row.id)
    await block.load()
    expect(block.peekProperty(syncMetricsRecordProp)).toMatchObject({ kind: 'drain', rows: 4000, wallMs: 1500, source: 'queue' })
    const types = await sharedDb.db.getAll<{ type: string }>('SELECT type FROM block_types WHERE block_id = ?', [row.id])
    expect(types.map(t => t.type)).toContain(syncMetricsRecordType.id)
  }, 20_000)
})
