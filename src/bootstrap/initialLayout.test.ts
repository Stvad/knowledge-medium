// @vitest-environment happy-dom
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '@/data/repo'
import { parseBlockRow, type BlockRow } from '@/data/blockSchema'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { releaseTestRepos } from '@/data/test/testRepoScope'
import {
  clearSyncState,
  drainStaged,
  hasFirstSyncMarker,
  insertWorkspaceRow,
  serverBlock,
  serverWorkspace,
  stagedBlock as stagedBlockIn,
  syncServer,
  testWorkspaceRow,
} from '@/data/test/syncCheckpoint'
import { recordWorkspaceFirstSync } from '@/data/workspaceFirstSync'
import { setModePin } from '@/sync/keys/modePin'
import { buildAppHash } from '@/utils/routing'
import { dailyNotesDataExtension } from '@/plugins/daily-notes/dataExtension'
import { resolveWorkspace } from './resolveWorkspace'
import { prepareInitialLayout, preparedInitialHash, resolveInitialLayout } from './initialLayout'

// The real resolution, except where a test stands in for the ensure-personal
// and access RPCs, which need a server.
vi.mock('./resolveWorkspace', async importOriginal => {
  const actual = await importOriginal<typeof import('./resolveWorkspace')>()
  return {...actual, resolveWorkspace: vi.fn(actual.resolveWorkspace)}
})

// App must key its first lookup on the exact hash the boot prepared for, not on
// a re-read of location.hash: the landing step may already have rewritten it.
describe('prepareInitialLayout', () => {
  it('records the hash it resolved for', () => {
    const repo = {instanceId: 4242} as unknown as Repo
    window.location.hash = '#prepared-here'
    expect(preparedInitialHash(repo)).toBeUndefined()
    void prepareInitialLayout(repo, false).catch(() => {})
    expect(preparedInitialHash(repo)).toBe('#prepared-here')
  })
})

const WS = 'ws-layout'
const USER = 'user-1'

const workspaceRow = testWorkspaceRow(WS, USER)
const stagedBlock = (id: string) => stagedBlockIn(id, WS)

let shared: TestDb
let repo: Repo
let deliver: ReturnType<typeof syncServer>

beforeAll(async () => { shared = await createTestDb() })
afterAll(async () => { await shared.cleanup() })
beforeEach(async () => {
  await clearSyncState(shared.db)
  await resetTestDb(shared.db)
  localStorage.clear()
  setModePin(USER, WS, 'plaintext')
  repo = createTestRepo({db: shared.db, user: {id: USER}, extensions: [dailyNotesDataExtension]}).repo
  deliver = syncServer(shared.db)
})

const open = (useRemoteSync = true) => resolveInitialLayout(repo, buildAppHash(WS), useRemoteSync)
const drain = () => drainStaged(shared.db)
const marked = () => hasFirstSyncMarker(shared.db, WS)
const primeRow = () => insertWorkspaceRow(shared.db, WS, USER)
const localBlockCount = async () => (await shared.db.get<{n: number}>('SELECT count(*) AS n FROM blocks')).n

// The first bootstrap in the file measured ~1.3s alone (a cold landing runtime).
describe('resolveInitialLayout — first sync', {timeout: 20_000}, () => {
  it('holds a workspace whose first sync is not materialized, read-only and unbootstrapped', async () => {
    await deliver([serverWorkspace(workspaceRow), stagedBlock('b1')])

    const layout = await open()

    expect(layout).toEqual({kind: 'syncing', workspaceId: WS, workspaceName: 'test', awaitingRow: false})
    expect(repo.isReadOnly).toBe(true)
    expect(await localBlockCount()).toBe(0)
    expect(await shared.db.getAll('SELECT id FROM ps_crud')).toEqual([])
  })

  it('holds a workspace whose row has not arrived, awaiting the row, and forgets its old marker', async () => {
    await recordWorkspaceFirstSync(shared.db, WS)
    vi.mocked(resolveWorkspace).mockResolvedValueOnce({id: WS, freshlyCreated: false})

    expect(await open()).toEqual({kind: 'syncing', workspaceId: WS, workspaceName: null, awaitingRow: true})
    expect(repo.isReadOnly).toBe(true)
    expect(await marked()).toBe(false)
  })

  it('holds a locked workspace read-only', async () => {
    await primeRow()
    localStorage.clear() // unpinned: quarantined

    expect((await open()).kind).toBe('locked')
    expect(repo.isReadOnly).toBe(true)
  })

  it('opens a workspace this run just created without waiting for a sync, and records it', async () => {
    await primeRow()
    vi.mocked(resolveWorkspace).mockResolvedValueOnce({id: WS, freshlyCreated: true})

    expect((await open()).kind).toBe('ready')
    expect(await marked()).toBe(true)
  })

  it('opens without a sync check in a local-only session, never read-only on the way', async () => {
    await primeRow()
    const readOnly = vi.spyOn(repo, 'setReadOnly')

    expect((await open(false)).kind).toBe('ready')
    expect(readOnly.mock.calls).toEqual([[false]])
  })

  it('records the workspace the first time it is caught up, and opens it on that record after', async () => {
    await deliver([serverWorkspace(workspaceRow)])
    expect((await open()).kind).toBe('ready')
    expect(await marked()).toBe(true)

    await deliver([stagedBlock('b1')])
    expect((await open()).kind).toBe('ready')
  })

  it('bootstraps over the materialized server rows instead of minting its own', async () => {
    // What the server holds: the rows a first device's bootstrap wrote.
    await primeRow()
    expect((await open(false)).kind).toBe('ready')
    const serverRows = (await shared.db.getAll<BlockRow>('SELECT * FROM blocks WHERE workspace_id = ?', [WS]))
      .map(row => serverBlock(parseBlockRow(row)))
    expect(serverRows.length).toBeGreaterThan(0)
    await releaseTestRepos([repo])
    await clearSyncState(shared.db)
    await resetTestDb(shared.db)
    repo = createTestRepo({db: shared.db, user: {id: USER}, extensions: [dailyNotesDataExtension]}).repo

    // A fresh device: the download lands staged, raw, with nothing applied.
    await deliver([serverWorkspace(workspaceRow), ...serverRows])
    expect((await open()).kind).toBe('syncing')
    await drain()
    expect((await open()).kind).toBe('ready')

    const minted = await shared.db.getAll<{id: string}>(
      "SELECT json_extract(data, '$.id') AS id FROM ps_crud WHERE json_extract(data, '$.op') = 'PUT'",
    )
    const serverIds = new Set(serverRows.map(row => row.id))
    expect(minted.filter(row => serverIds.has(row.id))).toEqual([])
  })
})
