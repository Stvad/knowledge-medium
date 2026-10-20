// @vitest-environment happy-dom
/**
 * An open end-to-end encrypted workspace whose key record disappears — the
 * browser evicted site storage, or IndexedDB failed — locks into the same key
 * gate the entry check shows, at the first read that needs the key.
 *
 * Real: App's gate wiring, the entry resolution, the key gate, the key store,
 * the references processor and the upload orchestrator. Stood in: workspace
 * selection, the bootstrap writes and the rendered tree, none of which decide
 * whether the workspace is locked.
 */

import { Suspense } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChangeScope } from '@/data/api'
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { readWorkspaceEncryptionMode } from '@/data/workspaceSchema'
import { referencesDataExtension } from '@/plugins/references/dataExtension'
import {
  __encryptUploadOpsForTest,
  __runUploadLoopForTest,
  type CompactedBlockOperation,
} from '@/services/powersync'
import { bootstrapWorkspace } from '@/bootstrap/workspaceBootstrap.js'
import { hasEnvelopePrefix } from '@/sync/crypto/envelope'
import { getWorkspaceKeyStore } from '@/sync/keys/keyStore'
import { mintWorkspaceKey, type MintedWorkspaceKey } from '@/sync/keys/mintWorkspaceKey'
import { setModePin } from '@/sync/keys/modePin'
import { requireWorkspaceKeys } from '@/sync/keys/openWorkspaceKeys'
import { createSyncResolver } from '@/sync/keys/resolver'

const repoRef = vi.hoisted(() => ({current: undefined as Repo | undefined}))
const USER = 'user-key-loss'
const WS = 'ws-key-loss'

vi.mock('@/context/repo.tsx', () => ({
  useRepo: () => {
    if (!repoRef.current) throw new Error('test repo not initialised')
    return repoRef.current
  },
}))
vi.mock('@/bootstrap/resolveWorkspace.js', () => ({
  resolveWorkspace: vi.fn(async () => ({id: WS, freshlyCreated: false})),
}))
vi.mock('@/data/workspaces.js', async () => ({
  ...await vi.importActual<typeof import('@/data/workspaces.js')>('@/data/workspaces.js'),
  getLocalMemberRole: vi.fn(async () => 'owner'),
}))
vi.mock('@/bootstrap/workspaceBootstrap.js', () => ({
  bootstrapWorkspace: vi.fn(async () => ({id: 'layout-session'} as unknown as Block)),
}))
vi.mock('@/hooks/useWorkspaces.js', () => ({
  useMyWorkspaceRoles: () => ({rolesByWorkspaceId: new Map(), isLoading: false}),
}))
vi.mock('@/components/Login.js', () => ({useIsLocalOnly: () => true}))
vi.mock('react-use', () => ({useSearchParam: () => null}))
vi.mock('@/extensions/AppRuntimeProvider.js', () => ({
  AppRuntimeProvider: ({children}: {children: React.ReactNode}) => children,
}))
vi.mock('@/components/BlockComponent.tsx', () => ({
  BlockComponent: ({blockId}: {blockId: string}) => <div data-testid="workspace-open" data-block-id={blockId}/>,
}))

import App from './App'

let shared: TestDb
let repo: Repo
let minted: MintedWorkspaceKey

beforeAll(async () => { shared = await createTestDb() })
afterAll(async () => { await shared.cleanup() })
beforeEach(async () => {
  await resetTestDb(shared.db)
  localStorage.clear()
  minted = await mintWorkspaceKey(WS)
  await shared.db.execute(
    `INSERT INTO workspaces
       (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
     VALUES (?, 'Notes', ?, 1, 1, 'e2ee', ?, 'cell')`,
    [WS, USER, minted.canary])
  setModePin(USER, WS, 'e2ee')
  await getWorkspaceKeyStore().put(USER, WS, minted.record)
  repo = createTestRepo({db: shared.db, user: {id: USER}, extensions: [referencesDataExtension]}).repo
  repoRef.current = repo
  window.location.hash = ''
})
afterEach(async () => {
  cleanup()
  await getWorkspaceKeyStore().delete(USER, WS)
  repoRef.current = undefined
  vi.restoreAllMocks()
})

/** One upload pass over `ps_crud`, deciding modes and keys the way production
 *  does, into a sink that records what would have gone out. */
const uploadPass = () => {
  const resolver = createSyncResolver(() => USER, getWorkspaceKeyStore(), ws => readWorkspaceEncryptionMode(shared.db, ws))
  const sent: CompactedBlockOperation[] = []
  const pass = __runUploadLoopForTest(shared.db, {
    applyOperations: async (_db, ops) => { sent.push(...ops) },
    recordRejection: async (_db, _tx, err) => { throw new Error(`quarantined: ${String(err)}`) },
    encryptOps: ops => __encryptUploadOpsForTest(ops, resolver.getUploadMode, resolver.getCek),
  }, new Map())
  return {pass, sent}
}

const liveClaimants = async (alias: string) => (await shared.db.getAll<{id: string}>(
  `SELECT b.id FROM block_aliases a JOIN blocks b ON b.id = a.block_id
    WHERE a.workspace_id = ? AND a.alias = ? AND b.deleted = 0`,
  [WS, alias])).map(row => row.id)

const openApp = async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  // `use()` suspends on the initial layout; awaiting inside `act` flushes the retry.
  await act(async () => { render(<Suspense fallback={null}><App/></Suspense>) })
  await screen.findByTestId('workspace-open')
}

/** The browser drops the key record, then the user writes a link to a new page. */
const loseKeyThenLink = async () => {
  await getWorkspaceKeyStore().delete(USER, WS)
  await act(async () => {
    await repo.tx(async tx => {
      await tx.create({id: 'src', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'see [[New Page]]'})
    }, {scope: ChangeScope.BlockDefault, description: 'edit'})
    await repo.awaitProcessors()
  })
}

describe('an open encrypted workspace whose key record disappears', () => {
  it('locks into the key gate, writes and uploads nothing that needs the key, and resumes on a re-paste', async () => {
    await openApp()
    await loseKeyThenLink()

    // Locked: the entry gate's own state, prompting for the key.
    await screen.findByText(/"Notes" needs its key/)
    expect(screen.queryByTestId('workspace-open')).toBeNull()
    expect(repo.isReadOnly).toBe(true)
    // No page minted for the link, under any namespace.
    expect(await liveClaimants('New Page')).toEqual([])
    // Nothing went out: the edit stays queued.
    const locked = uploadPass()
    await expect(locked.pass).rejects.toThrow(/workspace key/)
    expect(locked.sent).toEqual([])

    fireEvent.change(screen.getByLabelText(/workspace key/i), {target: {value: minted.displayed}})
    await act(async () => { fireEvent.click(screen.getByRole('button', {name: /^unlock$/i})) })
    await screen.findByTestId('workspace-open')
    expect(repo.isReadOnly).toBe(false)

    const resumed = uploadPass()
    await resumed.pass
    const edit = resumed.sent.find(op => op.id === 'src')
    if (edit?.kind !== 'create') throw new Error(`the edit did not upload as a create: ${JSON.stringify(edit)}`)
    expect(hasEnvelopePrefix(String(edit.payload.content))).toBe(true)
  })

  it('still locks on a real loss after an unreadable store recovered by the time it was checked', async () => {
    await openApp()
    vi.mocked(bootstrapWorkspace).mockResolvedValueOnce({id: 'reopened'} as unknown as Block)
    const failure = new Error('IndexedDB connection lost')
    vi.spyOn(getWorkspaceKeyStore(), 'get').mockRejectedValueOnce(failure).mockRejectedValueOnce(failure)
    await act(async () => { await requireWorkspaceKeys(getWorkspaceKeyStore(), USER, WS).catch(() => {}) })
    // The re-resolve found the key and opened the workspace again: wait for that
    // layout to commit, then flush the effect that watches it.
    await vi.waitFor(() => expect(screen.getByTestId('workspace-open').dataset.blockId).toBe('reopened'))
    await act(async () => {})

    await loseKeyThenLink()

    await screen.findByText(/"Notes" needs its key/)
  })
})
