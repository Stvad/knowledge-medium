// @vitest-environment node
/**
 * `workspaceCaughtUp` — has this device downloaded AND materialized the
 * workspace's first sync. Every state is set up through the real PowerSync core
 * (`syncServer`), so `hasSynced`, the raw-table puts and the staging queue are
 * the ones a device would have.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { makeBlockData } from '@/data/test/factories'
import { clearSyncState, reloadSyncStatus, serverBlock, serverWorkspace, syncServer } from '@/data/test/syncCheckpoint'
import { constMat, drainStagingWindowOnce, noKey } from '@/data/internals/syncObserver/test/harness'
import type { WorkspaceRow } from '@/data/workspaceSchema'
import type { Repo } from '@/data/repo'
import { readWorkspaceFirstSync, recordWorkspaceFirstSync, workspaceCaughtUp } from './workspaceFirstSync'

const WS = 'ws-first-sync'
const OTHER = 'ws-other'

const workspaceRow = (id: string): WorkspaceRow => ({
  id, name: 'test', owner_user_id: 'user-1', create_time: 1, update_time: 1,
  encryption_mode: 'none', wk_canary: null, properties_migration: 'children',
})
const block = (id: string, workspaceId = WS) =>
  serverBlock(makeBlockData({id, workspaceId, content: id, createdAt: 1, updatedAt: 1, userUpdatedAt: 1}))

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

const drain = (materializability: 'copy' | 'defer' = 'copy') =>
  drainStagingWindowOnce(shared.db, {getMaterializability: constMat(materializability), getCek: noKey})

/** The row a resolve primes from the ensure-personal RPC before sync has it. */
const primeRow = (id: string) => shared.db.execute(
  `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time, encryption_mode, properties_migration)
   VALUES (?, 'test', 'user-1', 1, 1, 'none', 'children')`,
  [id],
)

const marked = async (id: string) =>
  (await shared.db.getOptional('SELECT 1 FROM client_schema_state WHERE key = ?', [`workspace_first_sync_v1:${id}`])) !== null

describe('workspaceCaughtUp', () => {
  it('is false while the download has landed but is not materialized', async () => {
    await deliver([serverWorkspace(workspaceRow(WS)), block('b1')])
    expect(shared.db.currentStatus.hasSynced).toBe(true)
    expect(await shared.db.getAll('SELECT seq FROM blocks_synced_changes')).not.toEqual([])

    expect(await workspaceCaughtUp(repo, WS)).toBe(false)
  })

  it('is false on a device that has never synced, and stays false re-read mid-download', async () => {
    await primeRow(WS)
    expect(await workspaceCaughtUp(repo, WS)).toBe(false)

    await deliver([serverWorkspace(workspaceRow(WS)), block('b1')], {complete: false})
    await reloadSyncStatus(shared.db)
    expect(shared.db.currentStatus.hasSynced).not.toBe(true)
    expect(await workspaceCaughtUp(repo, WS)).toBe(false)
  })

  it('is false for a workspace joined later on a synced device, and forgets its old marker', async () => {
    await deliver([serverWorkspace(workspaceRow(OTHER))])
    await recordWorkspaceFirstSync(shared.db, WS)
    expect(shared.db.currentStatus.hasSynced).toBe(true)

    expect(await workspaceCaughtUp(repo, WS)).toBe(false)
    expect(await marked(WS)).toBe(false)
  })

  it('is false while downloaded rows sit deferred with nothing queued', async () => {
    await deliver([serverWorkspace(workspaceRow(WS)), block('b1')])
    await drain('defer')
    expect(await shared.db.getAll('SELECT seq FROM blocks_synced_changes')).toEqual([])
    expect(await shared.db.getAll('SELECT id FROM blocks_synced WHERE needs_apply = 1')).toEqual([{id: 'b1'}])

    expect(await readWorkspaceFirstSync(repo, WS)).toMatchObject({kind: 'pending', gap: {transient: false}})
  })

  it('is true once recorded, however much is still queued', async () => {
    await primeRow(WS)
    await recordWorkspaceFirstSync(shared.db, WS)
    await deliver([block('b1'), block('b2')])

    expect(await readWorkspaceFirstSync(repo, WS)).toEqual({kind: 'recorded'})
  })

  it('is true once the first sync is downloaded and materialized, and records nothing itself', async () => {
    await deliver([serverWorkspace(workspaceRow(WS)), block('b1')])
    await drain()

    expect(await readWorkspaceFirstSync(repo, WS)).toEqual({kind: 'caught-up'})
    expect(await marked(WS)).toBe(false)
  })
})
