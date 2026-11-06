import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import type {Repo} from '@/data/repo'
import {primeLocalWorkspaceAndMember} from './workspaces.ts'
import type {Workspace, WorkspaceMembership} from '@/types'

const WS = 'ws-1'

const workspace: Workspace = {
  id: WS,
  name: 'WS',
  ownerUserId: 'user-1',
  createTime: 1,
  updateTime: 2,
  encryptionMode: 'none',
  wkCanary: null,
  propertiesMigration: 'children',
}

const member = {
  id: 'member-1',
  workspaceId: WS,
  userId: 'user-1',
  role: 'owner',
  createTime: 1,
} as WorkspaceMembership

describe('priming a local workspace row', () => {
  let db: TestDb
  let repo: Repo
  beforeAll(async () => {
    db = await createTestDb()
  })
  afterAll(() => db.cleanup())
  beforeEach(async () => {
    await resetTestDb(db.db)
    repo = createTestRepo({db: db.db, user: {id: 'user-1'}}).repo
  })

  const read = async () => (await db.db.get<{had_other_members: number | null}>(
    'SELECT had_other_members FROM workspaces WHERE id = ?', [WS],
  )).had_other_members

  it('leaves had_other_members unknown on a row it creates', async () => {
    await primeLocalWorkspaceAndMember(repo, workspace, member)
    expect(await read()).toBeNull()
  })

  // Every sign-in primes the personal workspace. Resetting this would hold all of
  // its documents, and the server has no reason to replay an unchanged row.
  it.each([0, 1])('keeps a synced had_other_members of %i', async value => {
    await primeLocalWorkspaceAndMember(repo, workspace, member)
    await db.db.execute('UPDATE workspaces SET had_other_members = ? WHERE id = ?', [value, WS])

    await primeLocalWorkspaceAndMember(repo, {...workspace, name: 'Renamed'}, member)

    expect(await read()).toBe(value)
  })
})
