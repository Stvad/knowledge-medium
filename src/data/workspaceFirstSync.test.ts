// @vitest-environment node
/**
 * `readWorkspaceFirstSync` — has this device downloaded AND materialized the
 * workspace's first sync. Every state is set up through the real PowerSync core
 * (`syncServer`), so `hasSynced`, the raw-table puts and the staging queue are
 * the ones a device would have.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import {
  clearSyncState,
  drainStaged,
  hasFirstSyncMarker,
  insertWorkspaceRow,
  reloadSyncStatus,
  serverWorkspace,
  stagedBlock,
  syncServer,
  testWorkspaceRow,
} from '@/data/test/syncCheckpoint'
import {
  grandfatherWorkspaceFirstSync,
  WORKSPACE_FIRST_SYNC_GRANDFATHERED_MARKER_KEY,
} from '@/data/internals/clientSchema'
import type { Repo } from '@/data/repo'
import { readWorkspaceFirstSync, recordWorkspaceFirstSync } from './workspaceFirstSync'

const WS = 'ws-first-sync'
const OTHER = 'ws-other'

let shared: TestDb
let repo: Repo
let deliver: ReturnType<typeof syncServer>

beforeAll(async () => { shared = await createTestDb() })
afterAll(async () => { await shared.cleanup() })
beforeEach(async () => {
  await clearSyncState(shared.db)
  await resetTestDb(shared.db)
  repo = createTestRepo({db: shared.db, user: {id: 'user-1'}}).repo
  deliver = syncServer(shared.db)
})

const kind = async (workspaceId = WS) => (await readWorkspaceFirstSync(repo, workspaceId)).kind

describe('readWorkspaceFirstSync', () => {
  it('is pending while the download has landed but is not materialized', async () => {
    await deliver([serverWorkspace(testWorkspaceRow(WS)), stagedBlock('b1', WS)])
    expect(shared.db.currentStatus.hasSynced).toBe(true)
    expect(await shared.db.getAll('SELECT seq FROM blocks_synced_changes')).not.toEqual([])

    expect(await kind()).toBe('pending')
  })

  it('is pending on a device that has never synced, and stays pending re-read mid-download', async () => {
    await insertWorkspaceRow(shared.db, WS)
    expect(await kind()).toBe('pending')

    await deliver([serverWorkspace(testWorkspaceRow(WS)), stagedBlock('b1', WS)], {complete: false})
    await reloadSyncStatus(shared.db)
    expect(shared.db.currentStatus.hasSynced).not.toBe(true)
    expect(await kind()).toBe('pending')
  })

  it('is pending for a workspace joined later on a synced device, and forgets its old marker', async () => {
    await deliver([serverWorkspace(testWorkspaceRow(OTHER))])
    await recordWorkspaceFirstSync(shared.db, WS)
    expect(shared.db.currentStatus.hasSynced).toBe(true)

    expect(await kind()).toBe('pending')
    expect(await hasFirstSyncMarker(shared.db, WS)).toBe(false)
  })

  it('is pending while downloaded rows sit deferred with nothing queued', async () => {
    await deliver([serverWorkspace(testWorkspaceRow(WS)), stagedBlock('b1', WS)])
    await drainStaged(shared.db, 'defer')
    expect(await shared.db.getAll('SELECT seq FROM blocks_synced_changes')).toEqual([])
    expect(await shared.db.getAll('SELECT id FROM blocks_synced WHERE needs_apply = 1')).toEqual([{id: 'b1'}])

    expect(await readWorkspaceFirstSync(repo, WS)).toMatchObject({kind: 'pending', gap: {transient: false}})
  })

  it('is recorded once recorded, however much is still queued', async () => {
    await insertWorkspaceRow(shared.db, WS)
    await recordWorkspaceFirstSync(shared.db, WS)
    await deliver([stagedBlock('b1', WS), stagedBlock('b2', WS)])

    expect(await kind()).toBe('recorded')
  })

  it('is caught up once the first sync is downloaded and materialized, and records nothing itself', async () => {
    await deliver([serverWorkspace(testWorkspaceRow(WS)), stagedBlock('b1', WS)])
    await drainStaged(shared.db)

    expect(await kind()).toBe('caught-up')
    expect(await hasFirstSyncMarker(shared.db, WS)).toBe(false)
  })

  it('is caught up while this device is offline or behind the server', async () => {
    await deliver([serverWorkspace(testWorkspaceRow(WS)), stagedBlock('b1', WS)])
    await drainStaged(shared.db)
    repo = createTestRepo({db: shared.db, user: {id: 'user-1'}, backfillSyncGate: () => () => {}}).repo
    expect(await repo.syncViewGap()).not.toBeNull()

    expect(await kind()).toBe('caught-up')
  })
})

describe('grandfatherWorkspaceFirstSync', () => {
  const runPass = () => grandfatherWorkspaceFirstSync({
    execute: (sql, params) => shared.db.execute(sql, params as never[] | undefined),
    getOptional: (sql, params) => shared.db.getOptional(sql, params as never[] | undefined),
  })
  beforeEach(async () => {
    await shared.db.execute('DELETE FROM client_schema_state WHERE key = ?', [WORKSPACE_FIRST_SYNC_GRANDFATHERED_MARKER_KEY])
  })

  it('records every workspace this device already has blocks for, deferred rows and all', async () => {
    await deliver([serverWorkspace(testWorkspaceRow(WS)), stagedBlock('b1', WS), stagedBlock('b2', WS)])
    await drainStaged(shared.db)
    await shared.db.execute("UPDATE blocks_synced SET needs_apply = 1 WHERE id = 'b2'")
    expect(await kind()).toBe('pending')

    await runPass()

    expect(await kind()).toBe('recorded')
  })

  it('leaves a workspace with no blocks here to the gate', async () => {
    await deliver([serverWorkspace(testWorkspaceRow(OTHER))])

    await runPass()

    expect(await hasFirstSyncMarker(shared.db, OTHER)).toBe(false)
  })

  it('runs once', async () => {
    await runPass()
    await deliver([serverWorkspace(testWorkspaceRow(WS)), stagedBlock('b1', WS)])
    await drainStaged(shared.db)

    await runPass()

    expect(await hasFirstSyncMarker(shared.db, WS)).toBe(false)
  })
})
