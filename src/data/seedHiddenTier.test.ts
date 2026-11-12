import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {ChangeScope, seedProperty} from '@/data/api'
import {
  canonicalPropertySeedProperties,
  materializePropertySeeds,
  propertyDefinitionBlockId,
} from '@/data/definitionSeeds'
import {propertyHiddenProp, seedRevisionProp} from '@/data/properties'
import {propertyFieldContent} from '@/data/propertyChildren'
import {setSeedHiddenTier, type SeedHiddenTierTarget} from '@/data/seedHiddenTier'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import type {Repo} from '@/data/repo'

const WS = 'ws-hidden-tier'

/** The stored before-state: a visible seed at revision 1. */
const storedSeed = (key: string) => seedProperty({
  seedKey: `system:test/property/${key}`,
  revision: 1,
  name: `test:${key}`,
  preset: 'string',
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})
const alpha = storedSeed('alpha')
const beta = storedSeed('beta')
const target = (seed: {seedKey: string}, revision = 2): SeedHiddenTierTarget =>
  ({seedKey: seed.seedKey, revision})
const idOf = (seed: {seedKey: string}) => propertyDefinitionBlockId(WS, seed.seedKey)

let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db}).repo
  repo.setActiveWorkspaceId(WS)
  await repo.ensureSystemPages(WS)
})

const storedBag = async (seed: {seedKey: string}) => {
  const row = await sharedDb.db.get<{properties_json: string}>(
    'SELECT properties_json FROM blocks WHERE id = ?', [idOf(seed)])
  return JSON.parse(row.properties_json) as Record<string, unknown>
}
const commandCount = async (description: string) => (await sharedDb.db.get<{n: number}>(
  'SELECT COUNT(*) AS n FROM command_events WHERE description = ?', [description])).n
const HIDE_TX = 'move seed definitions to hidden tier'

describe('setSeedHiddenTier hide', () => {
  it('writes only hidden and revision, under Automation, and a second run is a no-op', async () => {
    await materializePropertySeeds(repo, WS, [alpha, beta])
    const before = await storedBag(alpha)

    const first = await setSeedHiddenTier(repo, WS, [target(alpha), target(beta)], {direction: 'hide', apply: true})
    expect(first.counts).toEqual({upgraded: 2, alreadyCurrent: 0, skippedDiverged: 0, absent: 0})
    expect(await storedBag(alpha)).toEqual({
      ...before,
      [propertyHiddenProp.name]: true,
      [seedRevisionProp.name]: 2,
    })
    expect(await sharedDb.db.getAll<{scope: string}>(
      'SELECT scope FROM command_events WHERE description = ?', [HIDE_TX],
    )).toEqual([{scope: ChangeScope.Automation}])

    const second = await setSeedHiddenTier(repo, WS, [target(alpha), target(beta)], {direction: 'hide', apply: true})
    expect(second.counts).toEqual({upgraded: 0, alreadyCurrent: 2, skippedDiverged: 0, absent: 0})
    // The no-op tx records nothing.
    expect(await commandCount(HIDE_TX)).toBe(1)
  })

  it('dry run reports the plan the write then carries out, and writes nothing', async () => {
    await materializePropertySeeds(repo, WS, [alpha])
    const before = await storedBag(alpha)

    const plan = await setSeedHiddenTier(repo, WS, [target(alpha), target(beta)], {direction: 'hide', apply: false})
    expect(plan.applied).toBe(false)
    expect(plan.counts).toEqual({upgraded: 1, alreadyCurrent: 0, skippedDiverged: 0, absent: 1})
    expect(plan.seeds).toEqual([
      {seedKey: alpha.seedKey, blockId: idOf(alpha), status: 'upgraded',
        storedRevision: 1, storedHidden: false, writeRevision: 2},
      {seedKey: beta.seedKey, blockId: idOf(beta), status: 'absent', reason: 'no row'},
    ])
    expect(await storedBag(alpha)).toEqual(before)
    expect(await commandCount(HIDE_TX)).toBe(0)

    const applied = await setSeedHiddenTier(repo, WS, [target(alpha), target(beta)], {direction: 'hide', apply: true})
    expect(applied.seeds).toEqual(plan.seeds)
  })

  it('leaves tombstoned, unprovenanced and diverged rows alone', async () => {
    const gamma = storedSeed('gamma')
    const delta = storedSeed('delta')
    const forged = storedSeed('forged')
    const bare = storedSeed('bare')
    await materializePropertySeeds(repo, WS, [alpha, gamma, delta, bare])
    await repo.tx(async tx => {
      await tx.delete(idOf(alpha))
      // Visible at the declared revision: what a recovery run leaves.
      await tx.update(idOf(gamma), {properties: {...canonicalPropertySeedProperties(gamma), [seedRevisionProp.name]: 2}})
      // Hidden below the declared revision.
      await tx.update(idOf(delta), {properties: {...canonicalPropertySeedProperties(delta), [propertyHiddenProp.name]: true}})
      // No stored hidden at all.
      const {[propertyHiddenProp.name]: _hidden, ...withoutHidden} = canonicalPropertySeedProperties(bare)
      await tx.update(idOf(bare), {properties: withoutHidden})
      // At the deterministic id, without seed provenance.
      await tx.create({id: idOf(forged), workspaceId: WS, parentId: null, orderKey: 'a0', content: 'x',
        properties: {[propertyHiddenProp.name]: false, [seedRevisionProp.name]: 1}})
    }, {scope: ChangeScope.Automation})
    const bags = await Promise.all([gamma, delta, forged, bare].map(storedBag))

    const result = await setSeedHiddenTier(repo, WS, [alpha, gamma, delta, forged, bare].map(seed => target(seed)),
      {direction: 'hide', apply: true})
    expect(result.seeds.map(row => [row.status, row.reason])).toEqual([
      ['absent', 'tombstoned'],
      ['skipped-diverged', 'visible at revision 2, not below the declared 2'],
      ['skipped-diverged', 'hidden at revision 1, below the declared 2'],
      ['skipped-diverged', 'row is not seed-provenanced for this key'],
      ['skipped-diverged', 'stored revision or hidden is missing or undecodable'],
    ])
    expect(await Promise.all([gamma, delta, forged, bare].map(storedBag))).toEqual(bags)
    expect(await commandCount(HIDE_TX)).toBe(0)
  })

  it('refuses a workspace that is not the active one, or is read-only here', async () => {
    await materializePropertySeeds(repo, WS, [alpha])
    await expect(setSeedHiddenTier(repo, 'ws-elsewhere', [target(alpha)], {direction: 'hide', apply: false}))
      .rejects.toThrow(/not the active workspace/)
    repo.setReadOnly(true)
    await expect(setSeedHiddenTier(repo, WS, [target(alpha)], {direction: 'hide', apply: true}))
      .rejects.toThrow(/read-only/)
    repo.setReadOnly(false)
    expect((await storedBag(alpha))[propertyHiddenProp.name]).toBe(false)
  })
})

describe('setSeedHiddenTier unhide (recovery)', () => {
  it('reverses a hide past the declared revision, and a later hide reads it as diverged', async () => {
    await materializePropertySeeds(repo, WS, [alpha])
    await setSeedHiddenTier(repo, WS, [target(alpha)], {direction: 'hide', apply: true})

    const undone = await setSeedHiddenTier(repo, WS, [target(alpha)], {direction: 'unhide', apply: true})
    expect(undone.seeds[0]).toMatchObject({status: 'upgraded', storedRevision: 2, storedHidden: true, writeRevision: 3})
    expect(await storedBag(alpha)).toMatchObject({[propertyHiddenProp.name]: false, [seedRevisionProp.name]: 3})

    const again = await setSeedHiddenTier(repo, WS, [target(alpha)], {direction: 'unhide', apply: true})
    expect(again.counts).toEqual({upgraded: 0, alreadyCurrent: 1, skippedDiverged: 0, absent: 0})
    const rehide = await setSeedHiddenTier(repo, WS, [target(alpha)], {direction: 'hide', apply: true})
    expect(rehide.counts).toEqual({upgraded: 0, alreadyCurrent: 0, skippedDiverged: 1, absent: 0})
  })
})

describe('setSeedHiddenTier on a child-backed workspace', () => {
  const flip = () => sharedDb.db.execute(
    `INSERT OR REPLACE INTO workspaces (id, name, owner_user_id, create_time, update_time,
       encryption_mode, wk_canary, properties_migration)
     VALUES (?, 'test ws', 'user-1', 1, 1, 'none', NULL, 'children')`, [WS])

  /** The definition row's field rows for one property, with their live value
   *  children's content. */
  const fieldRows = async (ownerId: string, prop: {seedKey: string}) => {
    const fields = await sharedDb.db.getAll<{id: string}>(
      'SELECT id FROM blocks WHERE parent_id = ? AND content = ? AND deleted = 0',
      [ownerId, propertyFieldContent(propertyDefinitionBlockId(WS, prop.seedKey))])
    return Promise.all(fields.map(async field => (await sharedDb.db.getAll<{content: string}>(
      'SELECT content FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id', [field.id],
    )).map(value => value.content)))
  }

  it('reconciles the definition row\'s own field and value children with the new cell', async () => {
    await flip()
    await materializePropertySeeds(repo, WS, [alpha])
    // Precondition: the bag write being tested has children to reconcile.
    expect(await fieldRows(idOf(alpha), propertyHiddenProp)).toEqual([['false']])
    expect(await fieldRows(idOf(alpha), seedRevisionProp)).toEqual([['1']])

    await setSeedHiddenTier(repo, WS, [target(alpha)], {direction: 'hide', apply: true})
    expect(await fieldRows(idOf(alpha), propertyHiddenProp)).toEqual([['true']])
    expect(await fieldRows(idOf(alpha), seedRevisionProp)).toEqual([['2']])

    await setSeedHiddenTier(repo, WS, [target(alpha)], {direction: 'unhide', apply: true})
    expect(await fieldRows(idOf(alpha), propertyHiddenProp)).toEqual([['false']])
    expect(await fieldRows(idOf(alpha), seedRevisionProp)).toEqual([['3']])
  })
})
