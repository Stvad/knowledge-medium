// @vitest-environment node
import type {Transaction} from '@powersync/common'
import {afterAll, beforeAll, beforeEach, expect, it, vi} from 'vitest'
import {BLOCKS_SYNCED_RAW_TABLE, blockToSyncedRowParams} from '@/data/blockSchema'
import {createTestDb, resetTestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {makeBlockData} from '@/data/test/factories'
import {
  clearSyncState, drainStaged, insertWorkspaceRow, serverWorkspace, stagedBlock, syncServer, testWorkspaceRow,
} from '@/data/test/syncCheckpoint'
import {WORKSPACE_MEMBERS_RAW_TABLE, WORKSPACES_RAW_TABLE} from '@/data/workspaceSchema'
import {startReadGate} from './gate'

const workspaceId = 'workspace'
const user = {id: 'member'}
const workspace = testWorkspaceRow(workspaceId)
const member = {type: 'workspace_members' as const, id: 'original-membership', data: {
  workspace_id: workspaceId, user_id: user.id, role: 'editor', create_time: 1,
}}
const rejoinedId = 'new-membership'
const access = {writable: true, isUploadHeld: () => false}
let fixture: Awaited<ReturnType<typeof createTestDb>>
beforeAll(async () => { fixture = await createTestDb() })
beforeEach(async () => {
  await clearSyncState(fixture.db)
  await resetTestDb(fixture.db)
})
afterAll(async () => { await fixture.cleanup() })

async function replaceMembership(tx: Transaction, role = member.data.role) {
  // Accepting an invitation after removal gives the member a new id and create_time.
  await tx.execute(WORKSPACE_MEMBERS_RAW_TABLE.delete.sql, [member.id])
  await tx.execute(WORKSPACE_MEMBERS_RAW_TABLE.put.sql, [rejoinedId, workspaceId, user.id, role, 2])
}

function holdBootstrap() {
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  return {finish, pending}
}

it('fences writable bootstrap and disposes watchers after a same-role rejoin in one snapshot', async () => {
  const {db} = fixture
  await syncServer(db)([serverWorkspace(workspace), member])
  const {repo} = createTestRepo({db, user, isReadOnly: true})
  const openedReadOnly: boolean[] = []
  const visibility = vi.fn()
  const gate = startReadGate(db, repo, workspaceId, undefined,
    async () => { openedReadOnly.push(repo.isReadOnly) }, visibility, access)
  try {
    await vi.waitFor(() => expect(gate.reason()).toBeNull())
    expect(repo.isReadOnly).toBe(false)
    const block = makeBlockData({id: 'rejoined-block', workspaceId, content: 'downloaded after rejoin'})
    // A checkpoint can make the replacement and its backlog visible at once.
    await db.writeTransaction(async tx => {
      await replaceMembership(tx)
      await tx.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, blockToSyncedRowParams(block))
    })
    expect(await db.getAll('SELECT id, role, create_time FROM workspace_members')).toEqual([
      {id: rejoinedId, role: 'editor', create_time: 2},
    ])
    expect(await gate.readReason()).toEqual(expect.any(String))
    expect(repo.isReadOnly).toBe(true)
    expect(openedReadOnly).toEqual([false])
    expect(visibility.mock.calls).toEqual([[true], [false]])
    expect(await db.getOptional('SELECT content FROM blocks WHERE id = ?', [block.id])).toBeNull()

    await drainStaged(db)
    await vi.waitFor(() => expect(gate.reason()).toBeNull())
    expect(await db.getOptional('SELECT content FROM blocks WHERE id = ?', [block.id])).toEqual({content: block.content})
    expect(openedReadOnly).toEqual([false, false])
    expect(repo.isReadOnly).toBe(false)
    expect(visibility.mock.calls).toEqual([[true], [false], [true]])
  } finally {
    await gate.stop()
  }
})

it('disposes watchers and bootstraps again when a same-role rejoin already has a complete view', async () => {
  const {db} = fixture
  await syncServer(db)([serverWorkspace(workspace), member])
  const {repo} = createTestRepo({db, user, isReadOnly: true})
  const nextBootstrap = holdBootstrap()
  const open = vi.fn(async () => {})
    .mockResolvedValueOnce(undefined)
    .mockImplementationOnce(() => nextBootstrap.pending)
  const visibility = vi.fn()
  const gate = startReadGate(db, repo, workspaceId, undefined, open, visibility, access)
  try {
    await vi.waitFor(() => expect(gate.reason()).toBeNull())
    expect(await repo.workspaceViewGap(workspaceId)).toBeNull()
    await db.writeTransaction(tx => replaceMembership(tx))
    expect(await gate.readReason()).toEqual(expect.any(String))
    expect(open).toHaveBeenCalledTimes(2)
    expect(visibility.mock.calls).toEqual([[true], [false]])

    nextBootstrap.finish()
    await vi.waitFor(() => expect(gate.reason()).toBeNull())
    expect(visibility.mock.calls).toEqual([[true], [false], [true]])
  } finally {
    nextBootstrap.finish()
    await gate.stop()
  }
})

it('aborts an unfinished viewer bootstrap when a same-role membership replaces it', async () => {
  const {db} = fixture
  await syncServer(db)([serverWorkspace(workspace), {...member, data: {...member.data, role: 'viewer'}}])
  const {repo} = createTestRepo({db, user, isReadOnly: true})
  const oldBootstrap = holdBootstrap()
  const newBootstrap = holdBootstrap()
  const open = vi.fn<(signal: AbortSignal) => Promise<void>>()
    .mockImplementationOnce(() => oldBootstrap.pending)
    .mockImplementationOnce(() => newBootstrap.pending)
  const visibility = vi.fn()
  const gate = startReadGate(db, repo, workspaceId, undefined, open, visibility, access)
  try {
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce())
    await db.writeTransaction(tx => replaceMembership(tx, 'viewer'))
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2))
    expect(open.mock.calls[0]![0].aborted).toBe(true)
    expect(open.mock.calls[1]![0].aborted).toBe(false)
    expect(visibility).not.toHaveBeenCalled()

    oldBootstrap.finish()
    await oldBootstrap.pending
    expect(await gate.readReason()).toEqual(expect.any(String))
    expect(visibility).not.toHaveBeenCalled()
    newBootstrap.finish()
    await vi.waitFor(() => expect(gate.reason()).toBeNull())
    expect(repo.isReadOnly).toBe(true)
    expect(visibility.mock.calls).toEqual([[true]])
  } finally {
    oldBootstrap.finish()
    newBootstrap.finish()
    await gate.stop()
  }
})

it('closes when the workspace row disappears and checks the backlog when only that row returns', async () => {
  const {db} = fixture
  const deliver = syncServer(db)
  await deliver([serverWorkspace(workspace), member])
  const {repo} = createTestRepo({db, user, isReadOnly: true})
  const open = vi.fn(async () => {})
  const visibility = vi.fn()
  const gate = startReadGate(db, repo, workspaceId, undefined, open, visibility, access)
  const flush = vi.spyOn(repo, 'flushSyncObserver')
  try {
    await vi.waitFor(() => expect(gate.reason()).toBeNull())
    expect(repo.isReadOnly).toBe(false)
    const block = stagedBlock('workspace-return-block', workspaceId)
    await deliver([block])
    expect(await gate.readReason()).toBeNull()
    expect(await repo.workspaceViewGap(workspaceId)).toMatchObject({transient: true})

    await db.execute(WORKSPACES_RAW_TABLE.delete.sql, [workspaceId])
    await vi.waitFor(() => expect(gate.reason()).toBe('Waiting for the local workspace row'))
    expect(repo.isReadOnly).toBe(true)
    expect(open).toHaveBeenCalledOnce()
    expect(visibility.mock.calls).toEqual([[true], [false]])
    expect(flush).not.toHaveBeenCalled()

    await insertWorkspaceRow(db, workspaceId)
    await vi.waitFor(() => expect(flush).toHaveBeenCalled())
    expect(await gate.readReason()).toEqual(expect.any(String))
    expect(repo.isReadOnly).toBe(true)
    expect(open).toHaveBeenCalledOnce()
    expect(visibility.mock.calls).toEqual([[true], [false]])

    await drainStaged(db)
    await vi.waitFor(() => expect(gate.reason()).toBeNull())
    expect(repo.isReadOnly).toBe(false)
    expect(open).toHaveBeenCalledTimes(2)
    expect(visibility.mock.calls).toEqual([[true], [false], [true]])
  } finally {
    await gate.stop()
  }
})

it('preserves watcher visibility across an ordinary workspace update with blocks still staging', async () => {
  const {db} = fixture
  const deliver = syncServer(db)
  await deliver([serverWorkspace(workspace), member])
  const {repo} = createTestRepo({db, user, isReadOnly: true})
  const open = vi.fn(async () => {})
  const visibility = vi.fn()
  const gate = startReadGate(db, repo, workspaceId, undefined, open, visibility, access)
  try {
    await vi.waitFor(() => expect(gate.reason()).toBeNull())
    await deliver([serverWorkspace({...workspace, name: 'Renamed', update_time: 2}), member,
      stagedBlock('ordinary-download', workspaceId)])
    expect(await db.getOptional('SELECT name FROM workspaces WHERE id = ?', [workspaceId])).toEqual({name: 'Renamed'})
    expect(await repo.workspaceViewGap(workspaceId)).toMatchObject({transient: true})
    expect(await gate.readReason()).toBeNull()
    expect(repo.isReadOnly).toBe(false)
    expect(open).toHaveBeenCalledOnce()
    expect(visibility.mock.calls).toEqual([[true]])
  } finally {
    await gate.stop()
  }
})

it.each([
  ['download-only host', false, 'editor', false],
  ['viewer', true, 'viewer', false],
  ['upload hold', true, 'editor', true],
] as const)('withholds writable admission for a %s even when reads open', async (_, writable, role, held) => {
  const {db} = fixture
  await syncServer(db)([serverWorkspace(workspace), {...member, data: {...member.data, role}}])
  const {repo} = createTestRepo({db, user, isReadOnly: true})
  const onWritableAdmissionChanged = vi.fn()
  const gate = startReadGate(db, repo, workspaceId, undefined, async () => {}, () => {}, {
    writable, isUploadHeld: () => held, onWritableAdmissionChanged,
  })
  try {
    await vi.waitFor(() => expect(gate.reason()).toBeNull())
    expect(repo.isReadOnly).toBe(true)
    expect(onWritableAdmissionChanged).not.toHaveBeenCalled()
  } finally {
    await gate.stop()
  }
})

it('waits for preparation even when the member can already write and follows an in-place upload hold', async () => {
  const {db} = fixture
  await syncServer(db)([serverWorkspace(workspace), member])
  const {repo} = createTestRepo({db, user, isReadOnly: true})
  const preparing = holdBootstrap()
  const open = vi.fn(() => preparing.pending)
  const onWritableAdmissionChanged = vi.fn()
  let held = false
  const gate = startReadGate(db, repo, workspaceId, undefined, open, () => {}, {
    writable: true, isUploadHeld: () => held, onWritableAdmissionChanged,
  })
  try {
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce())
    expect(repo.isReadOnly).toBe(false)
    expect(onWritableAdmissionChanged).not.toHaveBeenCalled()
    preparing.finish()
    await vi.waitFor(() => expect(onWritableAdmissionChanged.mock.calls).toEqual([[true]]))
    held = true
    gate.uploadHoldChanged()
    expect(onWritableAdmissionChanged.mock.calls).toEqual([[true], [false]])
    held = false
    gate.uploadHoldChanged()
    expect(onWritableAdmissionChanged.mock.calls).toEqual([[true], [false], [true]])
  } finally {
    preparing.finish()
    await gate.stop()
  }
})
