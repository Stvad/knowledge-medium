// @vitest-environment node
/**
 * A property's value row may be a block other blocks link to (a gesture can
 * move any block into a value list). When the machinery removes it, its links
 * behave as for any block: a fold is a merge, so they follow it to the row it
 * folds into; a removal is a delete, so they inline its text.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, seedProperty, type BlockData, type User } from '@/data/api'
import { definitionSeedsFacet } from '@/data/facets'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { referencesDataExtension } from '../dataExtension.ts'

const USER: User = {id: 'user-1', name: 'Alice'}
const WS = 'ws-value-fold-retarget'
const MOVED = '22222222-2222-4222-8222-222222222222'
const LINKER = '33333333-3333-4333-8333-333333333333'

const statusProp = seedProperty({
  seedKey: 'test/property/value-fold-status', revision: 1, name: 'value-fold:status',
  preset: 'string', defaultValue: '', changeScope: ChangeScope.BlockDefault,
})
const tagsProp = seedProperty({
  seedKey: 'test/property/value-fold-tags', revision: 1, name: 'value-fold:tags',
  preset: 'string-list', defaultValue: [], changeScope: ChangeScope.BlockDefault,
})

let sharedDb: TestDb
let repo: Repo
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  await sharedDb.db.execute(
    `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time,
       encryption_mode, wk_canary, properties_migration)
     VALUES (?, 'test ws', ?, 1, 1, 'none', NULL, 'children')`, [WS, USER.id])
  repo = createTestRepo({db: sharedDb.db, user: USER}).repo
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    referencesDataExtension,
    definitionSeedsFacet.of(statusProp, {source: 'test'}),
    definitionSeedsFacet.of(tagsProp, {source: 'test'}),
  ]))
  repo.setActiveWorkspaceId(WS)
  await repo.tx(tx => tx.create({id: 'owner', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'owner'}),
    {scope: ChangeScope.BlockDefault})
  await vi.waitFor(() => expect(repo.propertySchemas.has(tagsProp.name)).toBe(true))
})

const valueRows = async (): Promise<BlockData[]> => {
  const [field] = (await repo.runQuery('core.children', {id: 'owner'}) as BlockData[]).filter(c => c.isFieldForm)
  return await repo.runQuery('core.children', {id: field!.id}) as BlockData[]
}

/** Move a block whose text is `content`, and which another block links to,
 *  into the owner's value list, after its values. */
const moveInLinkedBlock = async (content: string): Promise<void> => {
  const values = await valueRows()
  await repo.tx(async tx => {
    await tx.create({id: MOVED, workspaceId: WS, parentId: values[0]!.parentId, orderKey: 'zz', content})
    await tx.create({id: 'moved-child', workspaceId: WS, parentId: MOVED, orderKey: 'a0', content: 'note'})
    await tx.create({
      id: LINKER, workspaceId: WS, parentId: null, orderKey: 'a1',
      content: `see ((${MOVED}))`, references: [{id: MOVED, alias: MOVED}],
    })
  }, {scope: ChangeScope.BlockDefault})
  await repo.awaitProcessors()
}

const isDeleted = async (id: string): Promise<boolean> =>
  (await sharedDb.db.get<{deleted: number}>('SELECT deleted FROM blocks WHERE id = ?', [id])).deleted === 1
const contentOf = async (id: string): Promise<string> => (await repo.load(id))!.content

describe('a folded value row\'s links follow it', () => {
  it('a scalar write equal to a second value row', async () => {
    await repo.block('owner').set(statusProp, 'draft')
    await moveInLinkedBlock('final')
    const [primary] = await valueRows()

    // The first row takes the write and now equals the moved row, which folds.
    await repo.block('owner').set(statusProp, 'final')

    expect(await isDeleted(MOVED)).toBe(true)
    expect(await contentOf(LINKER)).toBe(`see ((${primary!.id}))`)
    expect((await repo.load('moved-child'))?.parentId).toBe(primary!.id)
  })

  it('a list write dropping a repeated member', async () => {
    await repo.block('owner').set(tagsProp, ['alpha'])
    await moveInLinkedBlock('alpha')
    const [kept] = await valueRows()

    await repo.block('owner').set(tagsProp, ['alpha'])

    expect(await isDeleted(MOVED)).toBe(true)
    expect(await contentOf(LINKER)).toBe(`see ((${kept!.id}))`)
  })
})

describe('a removed value row\'s links inline its text', () => {
  it('unsetting the property', async () => {
    await repo.block('owner').set(statusProp, 'draft')
    await moveInLinkedBlock('final')

    await repo.tx(tx => tx.unsetProperty('owner', statusProp), {scope: ChangeScope.BlockDefault})

    expect(await isDeleted(MOVED)).toBe(true)
    expect(await contentOf(LINKER)).toBe('see final')
  })

  it('a write that drops the property from the stored properties', async () => {
    await repo.block('owner').set(statusProp, 'draft')
    await moveInLinkedBlock('final')

    await repo.tx(async tx => {
      const properties = {...(await tx.get('owner'))!.properties}
      delete properties[statusProp.name]
      await tx.update('owner', {properties})
    }, {scope: ChangeScope.BlockDefault})

    expect(await isDeleted(MOVED)).toBe(true)
    expect(await contentOf(LINKER)).toBe('see final')
  })

  it('a list write dropping the member', async () => {
    await repo.block('owner').set(tagsProp, ['alpha'])
    await moveInLinkedBlock('beta')

    await repo.block('owner').set(tagsProp, ['alpha'])

    expect(await isDeleted(MOVED)).toBe(true)
    expect(await contentOf(LINKER)).toBe('see beta')
  })
})
