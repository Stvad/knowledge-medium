// @vitest-environment happy-dom
/**
 * The gate in front of a workspace whose first sync has not caught up here,
 * over a real database and the real PowerSync status: rows and `hasSynced`
 * arrive through the PowerSync core (`syncServer`).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PowerSyncContext } from '@powersync/react'
import type { AbstractPowerSyncDatabase } from '@powersync/common'
import { RepoContext } from '@/context/repo'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { makeBlockData } from '@/data/test/factories'
import { clearSyncState, serverBlock, serverWorkspace, syncServer } from '@/data/test/syncCheckpoint'
import { constMat, drainStagingWindowOnce, noKey } from '@/data/internals/syncObserver/test/harness'
import type { WorkspaceRow } from '@/data/workspaceSchema'
import type { Materializability } from '@/sync/transform'
import { WorkspaceSyncGate } from './WorkspaceSyncGate'

const WS = 'ws-gate'

const workspaceRow: WorkspaceRow = {
  id: WS, name: 'test', owner_user_id: 'user-1', create_time: 1, update_time: 1,
  encryption_mode: 'none', wk_canary: null, properties_migration: 'children',
}
const stagedBlock = (id: string) =>
  serverBlock(makeBlockData({id, workspaceId: WS, content: id, createdAt: 1, updatedAt: 1, userUpdatedAt: 1}))

let shared: TestDb
let repo: Repo
let deliver: ReturnType<typeof syncServer>
let materializability: Materializability

beforeAll(async () => { shared = await createTestDb() })
afterAll(async () => { await shared.cleanup() })
beforeEach(async () => {
  await clearSyncState(shared.db)
  await resetTestDb(shared.db)
  materializability = 'copy'
  repo = createTestRepo({db: shared.db, user: {id: 'user-1'}}).repo
  deliver = syncServer(shared.db)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const withObserver = () => {
  repo = createTestRepo({
    db: shared.db,
    user: {id: 'user-1'},
    startSyncObserver: true,
    syncObserverDeps: {getMaterializability: () => materializability, getCek: noKey},
  }).repo
}

const renderGate = (props: {awaitingRow?: boolean; onReady: () => void}) => render(
  <RepoContext value={repo}>
    <PowerSyncContext value={shared.db as unknown as AbstractPowerSyncDatabase}>
      <WorkspaceSyncGate workspaceId={WS} workspaceName="test" awaitingRow={props.awaitingRow ?? false} onReady={props.onReady}/>
    </PowerSyncContext>
  </RepoContext>,
)

/** Resolves once the gate has asked about the workspace `count` times. */
const askedTimes = (asks: {mock: {calls: unknown[]}}, count: number) =>
  vi.waitFor(() => expect(asks.mock.calls.length).toBeGreaterThanOrEqual(count))

describe('WorkspaceSyncGate', () => {
  it('does not open on status changes while the workspace is not caught up', async () => {
    await deliver([serverWorkspace(workspaceRow), stagedBlock('b1')])
    const asks = vi.spyOn(repo, 'workspaceViewGap')
    const onReady = vi.fn()
    renderGate({onReady})
    await askedTimes(asks, 1)

    const before = asks.mock.calls.length
    await deliver([stagedBlock('b2')])
    await askedTimes(asks, before + 1)

    expect(onReady).not.toHaveBeenCalled()
  })

  it('opens once, when the workspace catches up', async () => {
    await deliver([serverWorkspace(workspaceRow), stagedBlock('b1')])
    const asks = vi.spyOn(repo, 'workspaceViewGap')
    const onReady = vi.fn()
    renderGate({onReady})
    await askedTimes(asks, 1)

    await drainStagingWindowOnce(shared.db, {getMaterializability: constMat('copy'), getCek: noKey})
    await deliver([serverWorkspace(workspaceRow)])
    await vi.waitFor(() => expect(onReady).toHaveBeenCalled())

    const before = asks.mock.calls.length
    await deliver([serverWorkspace(workspaceRow)])
    await askedTimes(asks, before + 1)
    expect(onReady).toHaveBeenCalledTimes(1)
  })

  it('awaiting the row, opens when the row lands though the workspace is not caught up', async () => {
    const onReady = vi.fn()
    renderGate({awaitingRow: true, onReady})
    expect(onReady).not.toHaveBeenCalled()

    await deliver([serverWorkspace(workspaceRow), stagedBlock('b1')])

    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1))
  })

  it('kicks a stalled drain while waiting on it, and says when that fails', async () => {
    await deliver([serverWorkspace(workspaceRow), stagedBlock('b1')])
    vi.spyOn(repo, 'flushSyncObserver').mockRejectedValue(new Error('the drain window failed'))

    renderGate({onReady: vi.fn()})

    expect(await screen.findByText(/the drain window failed/)).toBeInTheDocument()
  })

  it('asks again once its kick has drained the queue, with nothing else to wake it', async () => {
    await shared.db.execute(
      `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time, encryption_mode, properties_migration)
       VALUES (?, 'test', 'user-1', 1, 1, 'none', 'children')`,
      [WS],
    )
    vi.spyOn(repo, 'flushSyncObserver').mockImplementation(async () => {
      await drainStagingWindowOnce(shared.db, {getMaterializability: constMat('copy'), getCek: noKey})
    })
    const onReady = vi.fn()
    renderGate({onReady})

    await deliver([stagedBlock('b1')])

    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1))
  })

  describe('downloaded rows deferred with nothing queued', () => {
    const deferDownload = async () => {
      materializability = 'defer'
      withObserver()
      await deliver([serverWorkspace(workspaceRow), stagedBlock('b1')])
      await repo.flushSyncObserver()
      expect(await shared.db.getAll('SELECT id FROM blocks_synced WHERE needs_apply = 1')).toEqual([{id: 'b1'}])
    }

    it('re-materializes them, and opens once that applies them', async () => {
      await deferDownload()
      materializability = 'copy'
      const repair = vi.spyOn(repo, 'rematerializeWorkspace')
      const onReady = vi.fn()

      renderGate({onReady})

      await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1))
      expect(repair).toHaveBeenCalledTimes(1)
      expect(repair).toHaveBeenCalledWith(WS, {scope: 'unapplied'})
    })

    it('offers to open anyway only once a completed pass leaves rows, and runs that pass once', async () => {
      await deferDownload()
      let finishPass!: () => void
      const passMayFinish = new Promise<void>(resolve => { finishPass = resolve })
      const original = repo.rematerializeWorkspace.bind(repo)
      const repair = vi.spyOn(repo, 'rematerializeWorkspace')
        .mockImplementation(async (...args) => { await passMayFinish; return original(...args) })
      const asks = vi.spyOn(repo, 'workspaceViewGap')
      const onReady = vi.fn()

      renderGate({onReady})
      await vi.waitFor(() => expect(repair).toHaveBeenCalled())
      expect(screen.queryByRole('button', {name: /open anyway/i})).toBeNull()
      finishPass()
      const openAnyway = await screen.findByRole('button', {name: /open anyway/i})

      const before = asks.mock.calls.length
      await deliver([serverWorkspace(workspaceRow)])
      await askedTimes(asks, before + 1)
      expect(repair).toHaveBeenCalledTimes(1)
      expect(onReady).not.toHaveBeenCalled()

      fireEvent.click(openAnyway)
      await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1))
      expect(await shared.db.getOptional(
        'SELECT 1 FROM client_schema_state WHERE key = ?', [`workspace_first_sync_v1:${WS}`],
      )).not.toBeNull()
    })
  })
})
