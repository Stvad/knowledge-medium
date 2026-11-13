// @vitest-environment node
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {ChangeScope} from '@/data/api'
import {isCollapsedProp} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo, childIdsOf} from '@/data/test/createTestRepo'
import {kernelDataExtension} from '@/data/kernelDataExtension'
import {resolveFacetRuntimeSync} from '@/facets/facet.js'
import {htmlDocumentActions} from '../actions.ts'
import {htmlDocumentDataExtension} from '../dataExtension.ts'

describe('the insert example action', () => {
  let sharedDb: TestDb
  let repo: Repo
  beforeAll(async () => { sharedDb = await createTestDb() })
  afterAll(async () => { await sharedDb.cleanup() })
  beforeEach(async () => {
    await resetTestDb(sharedDb.db)
    repo = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}, startSyncObserver: false}).repo
    repo.setFacetRuntime(resolveFacetRuntimeSync([kernelDataExtension, htmlDocumentDataExtension]))
    await repo.tx(async tx => {
      await tx.create({id: 'ui', workspaceId: 'ws', parentId: null, orderKey: 'a'})
      await tx.create({id: 'parent', workspaceId: 'ws', parentId: null, orderKey: 'b', content: 'parent'})
      await tx.setProperty('parent', isCollapsedProp, true)
    }, {scope: ChangeScope.BlockDefault})
  })

  it('shows what it inserted when the block it landed under was collapsed', async () => {
    const parent = repo.block('parent')
    await parent.load()
    await htmlDocumentActions[0].handler(
      {block: parent, uiStateBlock: repo.block('ui')} as never,
      new CustomEvent('test') as never,
    )
    expect(await childIdsOf(repo, parent.id)).toHaveLength(1)
    expect((await repo.load('parent'))?.properties[isCollapsedProp.name]).not.toBe(true)
  })
})
