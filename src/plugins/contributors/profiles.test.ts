import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {ChangeScope} from '@/data/api'
import {PAGE_TYPE, USER_TYPE} from '@/data/blockTypes'
import {aliasesProp, typesProp, userIdProp} from '@/data/properties'
import {ensureUserPageInTx, userPageBlockId} from '@/data/stateBlocks'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import type {Repo} from '@/data/repo'
import {applyTypeTagInTx} from '@/data/typeTagger'
import {contributorsDataExtension} from './dataExtension'
import {assertContributor, createContributor, ensureHumanContributor, listContributors} from './profiles'
import {
  CONTRIBUTOR_TYPE, attributionCreatorsProp, attributionEditorsProp,
  contributorKindProp, contributorRoleProp,
} from './schema'

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
  it('repairs the user marker before a profile kind can be edited to agent', async () => {
    await repo.withTxContext({contributorId: null}).tx(async tx => {
      await tx.create({id: USER_PAGE_ID, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Vlad',
        properties: {[typesProp.name]: [PAGE_TYPE, CONTRIBUTOR_TYPE], [aliasesProp.name]: ['Vlad', 'vlad'],
          [contributorKindProp.name]: 'agent'}})
    }, opts)

    await repo.withTxContext({contributorId: null}).tx(tx =>
      ensureHumanContributor(tx, WS, USER, repo.snapshotTypeRegistries()), opts,
    )
    expect((await repo.load(USER_PAGE_ID))?.properties[typesProp.name]).toContain(USER_TYPE)

    await repo.withTxContext({contributorId: null}).tx(tx =>
      tx.setProperty(USER_PAGE_ID, contributorKindProp, 'agent'), opts,
    )
    const updated = await repo.load(USER_PAGE_ID)
    expect(updated?.properties[contributorKindProp.name]).toBe('agent')
    await expect(repo.withTxContext({contributorId: null}).tx(tx =>
      assertContributor(tx, USER_PAGE_ID, WS, {allowHuman: false}), opts,
    )).rejects.toThrow(/agent or automation contributor/)
  })

  it.each(['cell', 'children'] as const)(
    'restores a deleted user contributor around an alias claimed elsewhere (%s storage)', async mode => {
      if (mode === 'children') {
        await db.db.execute(`INSERT INTO workspaces
          (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
          VALUES (?, 'Test', 'vlad', 1, 1, 'none', NULL, 'children')`, [WS])
        repo.setActiveWorkspaceId(WS)
      }
      const humanId = await createAutomaticUserContributor('human')
      await repo.withTxContext({contributorId: null}).tx(async tx => {
        await tx.setProperty(humanId, contributorRoleProp, 'Owner')
      }, opts)
      const agent = await createContributor(repo, WS, {name: 'Research agent', kind: 'agent'})

      await repo.withTxContext({contributorId: null}).tx(tx => tx.delete(humanId), opts)
      await repo.withTxContext({contributorId: null}).tx(async tx => {
        await tx.create({id: 'alias-owner', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Other page'})
        await repo.addTypeInTx(tx, 'alias-owner', PAGE_TYPE, {[aliasesProp.name]: ['Vlad']})
      }, opts)
      await repo.withTxContext({contributorId: agent.id}).tx(async tx => {
        await tx.create({id: 'agent-note', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Agent draft'})
      }, opts)

      await repo.tx(tx => tx.update('agent-note', {content: 'Human revision'}), opts)

      const restored = await repo.load(humanId)
      expect(restored?.deleted).toBe(false)
      expect(restored?.properties[typesProp.name]).toEqual(expect.arrayContaining([PAGE_TYPE, USER_TYPE, CONTRIBUTOR_TYPE]))
      expect(restored?.properties[userIdProp.name]).toBe(USER.id)
      expect(restored?.properties[contributorKindProp.name]).toBe('human')
      expect(restored?.properties[contributorRoleProp.name]).toBe('Owner')
      expect(restored?.properties[aliasesProp.name]).toContain(USER.id)
      expect(restored?.properties[aliasesProp.name]).not.toContain('Vlad')
      expect((await repo.load('alias-owner'))?.properties[aliasesProp.name]).toEqual(['Vlad'])
      expect((await repo.load('agent-note'))?.content).toBe('Human revision')
      expect((await repo.load('agent-note'))?.properties[attributionCreatorsProp.name]).toEqual([agent.id])
      expect((await repo.load('agent-note'))?.properties[attributionEditorsProp.name]).toEqual([humanId])
    },
  )

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
