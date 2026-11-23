// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { blockTypeLabelProp } from '@/data/properties'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { resolveFacetRuntimeSync } from '@/facets/facet'

const WS = 'ws-search-property-children'

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { await resetTestDb(sharedDb.db) })

/** A properties-as-blocks workspace holding three notes whose property VALUE
 *  is exactly the query, and one line of prose that merely contains it. An
 *  exact match outranks a containing one, so the values fill a small window
 *  ahead of the prose. */
const seed = async (): Promise<Repo> => {
  await sharedDb.db.execute(
    `INSERT INTO workspaces
       (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
     VALUES (?, 'test ws', 'user-1', 1, 1, 'none', NULL, 'children')`,
    [WS],
  )
  const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
  repo.setFacetRuntime(resolveFacetRuntimeSync([kernelDataExtension]))
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    for (const id of ['n1', 'n2', 'n3']) {
      await tx.create({id, workspaceId: WS, parentId: null, orderKey: id, content: `note ${id}`})
      await tx.setProperty(id, blockTypeLabelProp, 'heron')
    }
    await tx.create({id: 'prose', workspaceId: WS, parentId: 'n1', orderKey: 'a0', content: 'a heron on the river'})
  }, {scope: ChangeScope.BlockDefault})
  return repo
}

const ids = (rows: ReadonlyArray<{id: string}>): string[] => rows.map(row => row.id)

describe('core.searchByContent propertyChildren', () => {
  it("'none' leaves value rows out, ahead of the limit", async () => {
    const repo = await seed()
    const window = {workspaceId: WS, query: 'heron', limit: 1}
    // The precondition: without the view, the one-row window is a value row.
    const [crowding] = await repo.query.searchByContent(window).load()
    expect(crowding?.content).toBe('heron')
    const hits = await repo.query.searchByContent({...window, propertyChildren: 'none'}).load()
    expect(ids(hits)).toEqual(['prose'])
  })

  it("'none' leaves out a field row that itself matches", async () => {
    const repo = await seed()
    const fieldRow = (await repo.query.children({id: 'n1', propertyChildren: 'all'}).load())
      .find(row => row.isFieldForm === true)
    const definitionId = fieldRow?.referenceTargetId ?? ''
    const structural = await repo.query.searchByContent({workspaceId: WS, query: definitionId}).load()
    expect(structural.some(hit => hit.isFieldForm === true)).toBe(true)
    const hits = await repo.query
      .searchByContent({workspaceId: WS, query: definitionId, propertyChildren: 'none'})
      .load()
    expect(hits.some(hit => hit.isFieldForm === true)).toBe(false)
  })

  it("'none' composes with every filter clause", async () => {
    const repo = await seed()
    await repo.tx(async tx => {
      await tx.create({id: 'typed', workspaceId: WS, parentId: 'n2', orderKey: 'a0', content: 'heron, typed'})
      await repo.addTypeInTx(tx, 'typed', 'page')
    }, {scope: ChangeScope.BlockDefault})
    const search = (filter: {types?: string[]; excludeTypes?: string[]; underId?: string}) =>
      repo.query.searchByContent({workspaceId: WS, query: 'heron', filter, propertyChildren: 'none'}).load()
    expect(ids(await search({underId: 'n1'}))).toEqual(['prose'])
    expect(ids(await search({types: ['page']}))).toEqual(['typed'])
    expect(ids(await search({excludeTypes: ['page']}))).toEqual(['prose'])
  })

  it("a mounted 'none' handle follows a move out from under a field row", async () => {
    const repo = await seed()
    const fieldRow = (await repo.query.children({id: 'n3', propertyChildren: 'all'}).load())
      .find(row => row.isFieldForm === true)
    const [valueRow] = await repo.query.children({id: fieldRow?.id ?? '', propertyChildren: 'all'}).load()
    expect(valueRow?.content).toBe('heron')
    const handle = repo.query.searchByContent({workspaceId: WS, query: 'heron', propertyChildren: 'none'})
    const unsubscribe = handle.subscribe(() => {})
    expect(ids(await handle.load())).toEqual(['prose'])
    // A move changes no content, so the content channel says nothing.
    await repo.tx(tx => tx.move(valueRow!.id, {parentId: 'n3', orderKey: 'z0'}), {scope: ChangeScope.BlockDefault})
    await vi.waitFor(async () => {
      expect(ids(await handle.load())).toContain(valueRow!.id)
    })
    unsubscribe()
  })
})
