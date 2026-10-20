import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {ChangeScope} from '@/data/api'
import {ensureUserPageInTx, userPageBlockId} from '@/data/stateBlocks'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import type {Repo} from '@/data/repo'
import {applyTypeTagInTx} from '@/data/typeTagger'
import {contributorsDataExtension} from './dataExtension'
import {assertContributor, createContributor, ensureHumanContributor, listContributors} from './profiles'
import {CONTRIBUTOR_TYPE, contributorKindProp} from './schema'

const WS = 'workspace'
const USER = {id: 'vlad', name: 'Vlad'}
const USER_PAGE_ID = userPageBlockId(WS, USER.id)
const opts = {scope: ChangeScope.BlockDefault}

let db: TestDb
let repo: Repo

beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => {
  await resetTestDb(db.db)
  repo = createTestRepo({db: db.db, user: USER, extensions: [contributorsDataExtension]}).repo
})

const createAutomaticUserContributor = async (kind?: 'human' | 'agent' | 'automation'): Promise<string> => {
  const snapshot = repo.snapshotTypeRegistries()
  return repo.withTxContext({contributorId: null}).tx(async tx => {
    const id = await ensureUserPageInTx(tx, WS, USER, snapshot)
    await applyTypeTagInTx(tx, snapshot, {
      blockId: id,
      typeId: CONTRIBUTOR_TYPE,
      initialValues: kind === undefined ? {} : {[contributorKindProp.name]: kind},
    })
    return id
  }, opts)
}

describe('contributor profiles', () => {
  it.each([
    ['absent kind', undefined],
    ['agent kind', 'agent'],
    ['automation kind', 'automation'],
  ] as const)('reconciles an existing automatic user profile to human from %s kind', async (_label, kind) => {
    await createAutomaticUserContributor(kind)

    await repo.withTxContext({contributorId: null}).tx(async tx => {
      await ensureHumanContributor(tx, WS, USER, repo.snapshotTypeRegistries())
    }, opts)

    expect((await repo.load(USER_PAGE_ID))?.properties[contributorKindProp.name]).toBe('human')
  })

  it.each([
    ['absent kind', undefined],
    ['agent kind', 'agent'],
  ] as const)('rejects an automatic user profile with %s before reconciliation', async (_label, kind) => {
    await createAutomaticUserContributor(kind)
    expect((await listContributors(repo, WS)).contributors.find(profile => profile.id === USER_PAGE_ID)?.kind).toBe('human')

    await expect(repo.withTxContext({contributorId: null}).tx(tx =>
      assertContributor(tx, USER_PAGE_ID, WS, {allowHuman: false}), opts,
    )).rejects.toThrow(/agent or automation contributor/)
  })

  it('allows an ordinary agent contributor profile for external writes', async () => {
    const profile = await createContributor(repo, WS, {name: 'Research agent', kind: 'agent'})

    await expect(repo.withTxContext({contributorId: null}).tx(tx =>
      assertContributor(tx, profile.id, WS, {allowHuman: false}), opts,
    )).resolves.toBeUndefined()
  })

  it('keeps ordinary human contributor profiles ineligible for external writes', async () => {
    const profile = await createContributor(repo, WS, {name: 'Researcher', kind: 'human'})

    await expect(repo.withTxContext({contributorId: null}).tx(tx =>
      assertContributor(tx, profile.id, WS, {allowHuman: false}), opts,
    )).rejects.toThrow(/agent or automation contributor/)
  })
})
