// @vitest-environment happy-dom
/**
 * The gate in front of a workspace whose first sync has not caught up here,
 * over a real database and the real PowerSync status: rows and `hasSynced`
 * arrive through the PowerSync core (`syncServer`). The apply backlog is the
 * one input stood in for, so a test decides when it moves instead of racing
 * its throttle.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PowerSyncContext } from '@powersync/react'
import type { AbstractPowerSyncDatabase } from '@powersync/common'
import { RepoContext } from '@/context/repo'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import {
  clearSyncState,
  drainStaged,
  hasFirstSyncMarker,
  hasMarker,
  insertWorkspaceRow,
  serverWorkspace,
  stagedBlock as stagedBlockIn,
  syncServer,
  testWorkspaceRow,
} from '@/data/test/syncCheckpoint'
import type { Materializability } from '@/sync/transform'
import { WorkspaceSyncGate } from './WorkspaceSyncGate'
import { RECONCILE_FLAGS_TRUSTED_MARKER_PREFIX, syncBulkLoadScope } from '@/data/internals/clientSchema'
import { INSERT_BLOCK_SQL, noKey } from '@/data/internals/syncObserver/test/harness'
import { blockToRowParams } from '@/data/blockSchema'

const backlog = vi.hoisted(() => {
  let value = 0
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set: (next: number) => { value = next; for (const listener of listeners) listener() },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
})
vi.mock('@/hooks/useMaterializeBacklog', async () => {
  const {useSyncExternalStore} = await vi.importActual<typeof import('react')>('react')
  return {useMaterializeBacklog: () => useSyncExternalStore(backlog.subscribe, backlog.get)}
})

const WS = 'ws-gate'
const workspaceRow = testWorkspaceRow(WS)
const stagedBlock = (id: string) => stagedBlockIn(id, WS)

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
  backlog.set(0)
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
  it('holds bulk drain windows for as long as it is up', async () => {
    const release = vi.fn()
    const hold = vi.spyOn(repo, 'holdBulkSyncLoad').mockReturnValue(release)
    const {unmount} = renderGate({onReady: vi.fn()})
    await vi.waitFor(() => expect(hold).toHaveBeenCalledTimes(1))
    expect(hold).toHaveBeenCalledWith(WS)
    expect(release).not.toHaveBeenCalled()
    unmount()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('notes a workspace this device holds nothing of as a cold first sync', async () => {
    renderGate({awaitingRow: true, onReady: vi.fn()})
    await vi.waitFor(async () => expect(await hasMarker(shared.db, RECONCILE_FLAGS_TRUSTED_MARKER_PREFIX, WS)).toBe(true))
  })

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

  it('opens when a status change finds the workspace caught up', async () => {
    await deliver([serverWorkspace(workspaceRow), stagedBlock('b1')])
    const asks = vi.spyOn(repo, 'workspaceViewGap')
    const onReady = vi.fn()
    renderGate({onReady})
    await askedTimes(asks, 1)

    await drainStaged(shared.db)
    await deliver([serverWorkspace(workspaceRow)])

    await vi.waitFor(() => expect(onReady).toHaveBeenCalled())
  })

  it('shows the deferred search index being built, and opens once it is', async () => {
    await deliver([serverWorkspace(workspaceRow)])
    // Rows a bulk window inserted and whose build has not run: the state the
    // gate meets between a drain's last window and its build.
    await shared.db.writeTransaction(async tx => {
      await tx.execute('UPDATE tx_context SET source = NULL, scope = ? WHERE id = 1', [syncBulkLoadScope([WS])])
      await tx.execute(INSERT_BLOCK_SQL, blockToRowParams({
        id: 'b1', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'para', properties: {}, references: [],
        createdAt: 1, updatedAt: 1, userUpdatedAt: 1, createdBy: 'u', updatedBy: 'u', deleted: false,
      }))
      await tx.execute('UPDATE tx_context SET scope = NULL WHERE id = 1')
    })
    const onReady = vi.fn()
    renderGate({onReady})
    expect(await screen.findByText('Building the search index')).toBeTruthy()
    expect(onReady).not.toHaveBeenCalled()

    // The gate's own kick reaches an observer, whose drain ends with the build.
    withObserver()
    cleanup()
    renderGate({onReady})
    await vi.waitFor(() => expect(onReady).toHaveBeenCalled())
  })

  it('opens when the apply backlog moves and finds the workspace caught up', async () => {
    backlog.set(1)
    await deliver([serverWorkspace(workspaceRow), stagedBlock('b1')])
    const asks = vi.spyOn(repo, 'workspaceViewGap')
    const onReady = vi.fn()
    renderGate({onReady})
    await askedTimes(asks, 2)

    await drainStaged(shared.db)
    act(() => backlog.set(0))

    await vi.waitFor(() => expect(onReady).toHaveBeenCalled())
  })

  it('awaiting the row, opens when the row lands though the workspace is not caught up', async () => {
    const onReady = vi.fn()
    renderGate({awaitingRow: true, onReady})
    expect(onReady).not.toHaveBeenCalled()

    await deliver([serverWorkspace(workspaceRow), stagedBlock('b1')])

    await vi.waitFor(() => expect(onReady).toHaveBeenCalled())
  })

  it('asks again once its kick has drained the queue, with nothing else to wake it', async () => {
    await insertWorkspaceRow(shared.db, WS)
    const kick = vi.spyOn(repo, 'flushSyncObserver').mockImplementation(async () => { await drainStaged(shared.db) })
    const onReady = vi.fn()
    renderGate({onReady})

    await deliver([stagedBlock('b1')])

    await vi.waitFor(() => expect(onReady).toHaveBeenCalled())
    expect(kick).toHaveBeenCalled()
  })

  it('says when its drain kick fails, and kicks again on Try again', async () => {
    await deliver([serverWorkspace(workspaceRow), stagedBlock('b1')])
    const kick = vi.spyOn(repo, 'flushSyncObserver').mockRejectedValue(new Error('the drain window failed'))
    renderGate({onReady: vi.fn()})
    expect(await screen.findByText(/the drain window failed/)).toBeInTheDocument()
    const kicks = kick.mock.calls.length
    kick.mockResolvedValue()

    fireEvent.click(screen.getByRole('button', {name: /try again/i}))

    await vi.waitFor(() => expect(kick.mock.calls.length).toBeGreaterThan(kicks))
    await vi.waitFor(() => expect(screen.queryByText(/the drain window failed/)).toBeNull())
  })

  it('says when this device is offline', async () => {
    await deliver([serverWorkspace(workspaceRow), stagedBlock('b1')])
    expect(shared.db.currentStatus.connected).toBe(false)

    renderGate({onReady: vi.fn()})

    expect(screen.getByRole('status')).toHaveTextContent(/offline/i)
  })

  describe('downloaded rows deferred with nothing queued', () => {
    const deferDownload = async () => {
      materializability = 'defer'
      withObserver()
      await deliver([serverWorkspace(workspaceRow), stagedBlock('b1')])
      await repo.flushSyncObserver()
      expect(await shared.db.getAll('SELECT id FROM blocks_synced WHERE needs_apply = 1')).toEqual([{id: 'b1'}])
    }
    /** The pass, held until the test lets it finish. */
    const holdPass = () => {
      let finish!: () => void
      const mayFinish = new Promise<void>(resolve => { finish = resolve })
      const original = repo.rematerializeWorkspace.bind(repo)
      const pass = vi.spyOn(repo, 'rematerializeWorkspace')
        .mockImplementation(async (...args) => { await mayFinish; return original(...args) })
      return {pass, finish}
    }
    const openAnywayButton = () => screen.queryByRole('button', {name: /open anyway/i})

    it('re-materializes them, and opens once that applies them', async () => {
      await deferDownload()
      materializability = 'copy'
      const pass = vi.spyOn(repo, 'rematerializeWorkspace')
      const onReady = vi.fn()

      renderGate({onReady})

      await vi.waitFor(() => expect(onReady).toHaveBeenCalled())
      expect(pass).toHaveBeenCalledTimes(1)
      expect(pass).toHaveBeenCalledWith(WS, {scope: 'unapplied'})
    })

    it('offers to open anyway only once a completed pass leaves rows, and holds there', async () => {
      await deferDownload()
      const {pass, finish} = holdPass()
      const asks = vi.spyOn(repo, 'workspaceViewGap')
      const onReady = vi.fn()

      renderGate({onReady})
      await vi.waitFor(() => expect(pass).toHaveBeenCalled())
      expect(openAnywayButton()).toBeNull()
      finish()
      const openAnyway = await screen.findByRole('button', {name: /open anyway/i})

      const before = asks.mock.calls.length
      await deliver([serverWorkspace(workspaceRow)])
      await askedTimes(asks, before + 1)
      expect(pass).toHaveBeenCalledTimes(1)
      expect(onReady).not.toHaveBeenCalled()

      fireEvent.click(openAnyway)
      await vi.waitFor(() => expect(onReady).toHaveBeenCalled())
      expect(await hasFirstSyncMarker(shared.db, WS)).toBe(true)
    })

    it('runs another pass on Try again after one left rows', async () => {
      await deferDownload()
      const pass = vi.spyOn(repo, 'rematerializeWorkspace')
      renderGate({onReady: vi.fn()})
      await screen.findByRole('button', {name: /open anyway/i})

      fireEvent.click(screen.getByRole('button', {name: /try again/i}))

      await vi.waitFor(() => expect(pass).toHaveBeenCalledTimes(2))
    })

    it('says when a pass fails, offers no open-anyway, and retries on Try again', async () => {
      await deferDownload()
      const pass = vi.spyOn(repo, 'rematerializeWorkspace').mockRejectedValueOnce(new Error('the pass failed'))
      renderGate({onReady: vi.fn()})
      expect(await screen.findByText(/the pass failed/)).toBeInTheDocument()
      expect(openAnywayButton()).toBeNull()

      fireEvent.click(screen.getByRole('button', {name: /try again/i}))

      await vi.waitFor(() => expect(pass).toHaveBeenCalledTimes(2))
    })
  })
})
