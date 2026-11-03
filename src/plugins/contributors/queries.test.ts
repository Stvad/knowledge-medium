import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {ChangeScope} from '@/data/api'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {contributorsDataExtension} from './dataExtension'
import {CONTRIBUTOR_PROFILES_BY_IDS_QUERY} from './queries'
import {CONTRIBUTOR_TYPE} from './schema'

const WS = 'ws-contributors-query'
const OTHER_WS = 'ws-other-contributors-query'
const PROFILE_ID = 'arriving-profile'
let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}, extensions: [contributorsDataExtension]}).repo
  repo.setActiveWorkspaceId(WS)
})
afterEach(() => {
  repo.stopSyncObserver()
  repo.setActiveWorkspaceId(null)
})

const createProfile = async (id: string, workspaceId: string) => {
  repo.setActiveWorkspaceId(workspaceId)
  await repo.tx(async tx => {
    await tx.create({id, workspaceId, parentId: null, orderKey: 'a', content: 'Profile'})
    await repo.addTypeInTx(tx, id, CONTRIBUTOR_TYPE)
  }, {scope: ChangeScope.BlockDefault, context: {contributorId: null}})
}

describe('contributor profile query', () => {
  it('excludes requested IDs whose rows belong to another workspace', async () => {
    await createProfile(PROFILE_ID, OTHER_WS)
    repo.setActiveWorkspaceId(WS)

    const rows = await repo.query[CONTRIBUTOR_PROFILES_BY_IDS_QUERY]({
      workspaceId: WS,
      ids: [PROFILE_ID],
    }).load()

    expect(rows).toEqual([])
  })

  it('invalidates a subscribed missing ID when its profile arrives in this Repo', async () => {
    const handle = repo.query[CONTRIBUTOR_PROFILES_BY_IDS_QUERY]({
      workspaceId: WS,
      ids: [PROFILE_ID],
    })
    let notifications = 0
    const unsubscribe = handle.subscribe(() => { notifications += 1 })
    await handle.load()
    expect(handle.peek()).toEqual([])

    await createProfile(PROFILE_ID, WS)
    repo.setActiveWorkspaceId(WS)
    await vi.waitFor(() => expect(handle.peek()?.map(row => row.id)).toEqual([PROFILE_ID]))
    expect(notifications).toBeGreaterThan(0)
    unsubscribe()
  })
})
