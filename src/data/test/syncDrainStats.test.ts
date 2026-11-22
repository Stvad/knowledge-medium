// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import { BLOCKS_SYNCED_RAW_TABLE, blockToSyncedRowParams } from '@/data/blockSchema'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'
import type { BlockData } from '@/data/api'
import type { SyncDrainStats } from '@/data/internals/syncObserver/observer'

const syncedRow = (id: string): BlockData => ({
  id, workspaceId: 'ws1', parentId: null, orderKey: id, content: id,
  properties: {}, references: [], createdAt: 500, updatedAt: 900, userUpdatedAt: 900,
  createdBy: 'u', updatedBy: 'u', deleted: false,
})

let sharedDb: TestDb
const repos: Repo[] = []
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { await resetTestDb(sharedDb.db) })
afterEach(() => { for (const repo of repos.splice(0)) repo.stopSyncObserver() })

const stage = (id: string) =>
  sharedDb.db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, blockToSyncedRowParams(syncedRow(id)))

it('hands the first subscriber the drains that ended before it subscribed, once', async () => {
  const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}, startSyncObserver: true})
  repos.push(repo)
  await repo.flushSyncObserver()
  await stage('b1')
  await repo.flushSyncObserver()

  const first: SyncDrainStats[] = []
  const unsubscribe = repo.onSyncDrainStats(stats => first.push(stats))
  expect(first).toMatchObject([{source: 'queue', rows: 1, applied: 1}])
  expect(first[0]!.endedAtMs).toBeGreaterThan(0)

  const second: SyncDrainStats[] = []
  repo.onSyncDrainStats(stats => second.push(stats))
  expect(second).toEqual([])

  // With a subscriber present a drain is delivered live, not held.
  await stage('b2')
  await repo.flushSyncObserver()
  expect(first).toHaveLength(2)
  expect(second).toHaveLength(1)
  unsubscribe()
})
