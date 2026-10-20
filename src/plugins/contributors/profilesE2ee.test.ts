// @vitest-environment node
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {resolveAliasSeatNamespaces} from '@/data/aliasSeatNamespace'
import {USER_TYPE} from '@/data/blockTypes'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {
  seedWorkspaceRow as seedWorkspaceRowIn, storeWorkspaceKey, stubLocalStorage,
} from '@/data/test/e2eeFixtures'
import {PLAINTEXT_ALIAS_SEATS} from '@/data/test/plaintextAliasSeats'
import {createTestRepo} from '@/data/test/createTestRepo'
import {contributorsDataExtension} from './dataExtension'
import {CONTRIBUTOR_TYPE} from './schema'
import {createContributor} from './profiles'
import {computeAliasSeatId} from '@/data/targets'
import {getWorkspaceKeyStore} from '@/sync/keys/keyStore'
import {setModePin} from '@/sync/keys/modePin'

const USER = 'contributor-e2ee-user'

let sharedDb: TestDb
let repo: Repo
let workspaceCounter = 0
let workspaceId = ''

const seedEncryptedWorkspace = () =>
  seedWorkspaceRowIn(sharedDb.db, workspaceId, USER, 'e2ee')

const unlockWorkspace = () => storeWorkspaceKey(USER, workspaceId)

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
afterEach(async () => {
  await getWorkspaceKeyStore().delete(USER, workspaceId)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  stubLocalStorage()
  workspaceId = `ws-contributor-e2ee-${++workspaceCounter}`
  repo = createTestRepo({db: sharedDb.db, user: {id: USER}, extensions: [contributorsDataExtension]}).repo
  repo.setActiveWorkspaceId(workspaceId)
})

describe('contributor profiles in encrypted workspaces', () => {
  it('creates a profile at the workspace-derived alias seat without prior namespace resolution', async () => {
    await seedEncryptedWorkspace()
    setModePin(USER, workspaceId, 'e2ee')
    await unlockWorkspace()

    const profile = await createContributor(repo, workspaceId, {name: 'Atlas'})

    // Resolve only after creation: a setup resolve here would mask a missing
    // pre-lock resolve in createContributor itself.
    const seats = await resolveAliasSeatNamespaces(repo, workspaceId)
    expect(profile.id).toBe(computeAliasSeatId(seats, 'Atlas', workspaceId))
    expect(profile.id).not.toBe(computeAliasSeatId(PLAINTEXT_ALIAS_SEATS, 'Atlas', workspaceId))
  })

  it('refuses without a content key before opening a write transaction or creating user/profile rows', async () => {
    await seedEncryptedWorkspace()
    setModePin(USER, workspaceId, 'e2ee')
    const write = vi.spyOn(repo, 'tx')

    const error = await createContributor(repo, workspaceId, {name: 'Atlas'}).then(
      () => undefined,
      (caught: unknown) => caught,
    )

    expect.soft(error).toBeInstanceOf(Error)
    expect.soft(error instanceof Error ? error.message : String(error)).toMatch(/no content key/)
    expect.soft(write).not.toHaveBeenCalled()
    expect.soft(await sharedDb.db.getAll<{id: string}>(
      `SELECT b.id FROM blocks b JOIN block_types t ON t.block_id = b.id
        WHERE b.workspace_id = ? AND t.type IN (?, ?)`,
      [workspaceId, USER_TYPE, CONTRIBUTOR_TYPE],
    )).toEqual([])
  })
})
