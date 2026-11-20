// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { blockTypeLabelProp } from '@/data/properties'
import { createChildBackedRepo } from '@/data/test/childBackedWorkspace'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'

const WS = 'ws-search-property-children'

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { await resetTestDb(sharedDb.db) })

/** Three notes whose property VALUE is exactly the query, and one line of
 *  prose that merely contains it. An exact match outranks a containing one,
 *  so the values fill a small window ahead of the prose. */
const seed = async () => {
  const repo = await createChildBackedRepo(sharedDb.db, {workspaceId: WS})
  await repo.tx(async tx => {
    for (const id of ['n1', 'n2', 'n3']) {
      await tx.create({id, workspaceId: WS, parentId: null, orderKey: id, content: `note ${id}`})
      await tx.setProperty(id, blockTypeLabelProp, 'heron')
    }
    await tx.create({id: 'prose', workspaceId: WS, parentId: 'n1', orderKey: 'a0', content: 'a heron on the river'})
  }, {scope: ChangeScope.BlockDefault})
  return repo
}

describe('core.searchByContent propertyChildren', () => {
  it('searches property value rows by default', async () => {
    const repo = await seed()
    const hits = await repo.query.searchByContent({workspaceId: WS, query: 'heron'}).load()
    expect(hits.filter(hit => hit.content === 'heron')).toHaveLength(3)
    expect(hits.map(hit => hit.id)).toContain('prose')
  })

  it("'none' leaves field rows and their value rows out", async () => {
    const repo = await seed()
    const hits = await repo.query
      .searchByContent({workspaceId: WS, query: 'heron', propertyChildren: 'none'})
      .load()
    expect(hits.map(hit => hit.id)).toEqual(['prose'])
  })

  it("'none' applies ahead of the limit", async () => {
    const repo = await seed()
    const window = {workspaceId: WS, query: 'heron', limit: 1}
    // The precondition: without the view, the one-row window is a value row.
    const [crowding] = await repo.query.searchByContent(window).load()
    expect(crowding?.content).toBe('heron')
    const hits = await repo.query.searchByContent({...window, propertyChildren: 'none'}).load()
    expect(hits.map(hit => hit.id)).toEqual(['prose'])
  })

  it("'none' leaves out a field row that itself matches", async () => {
    const repo = await seed()
    const fieldRow = (await repo.query.children({id: 'n1', propertyChildren: 'all'}).load())
      .find(row => row.isFieldForm === true)!
    const definitionId = fieldRow.referenceTargetId!
    const structural = await repo.query.searchByContent({workspaceId: WS, query: definitionId}).load()
    expect(structural.some(hit => hit.isFieldForm === true)).toBe(true)
    const hits = await repo.query
      .searchByContent({workspaceId: WS, query: definitionId, propertyChildren: 'none'})
      .load()
    expect(hits.some(hit => hit.isFieldForm === true)).toBe(false)
  })

  it("'none' composes with a filter", async () => {
    const repo = await seed()
    const hits = await repo.query
      .searchByContent({workspaceId: WS, query: 'heron', filter: {underId: 'n1'}, propertyChildren: 'none'})
      .load()
    expect(hits.map(hit => hit.id)).toEqual(['prose'])
  })
})
