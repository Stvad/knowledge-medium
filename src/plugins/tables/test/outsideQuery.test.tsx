// @vitest-environment happy-dom
/** The host's children below a query table: a focused child the cache moves
 *  leaves or joins this listing in the same render as the outline's. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { ChangeScope } from '@/data/api'
import type { Block } from '@/data/block'
import { materializePropertySeeds, propertyDefinitionBlockId } from '@/data/definitionSeeds'
import { focusedBlockLocationProp } from '@/data/properties'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { useOutsideQueryIds } from '../QueryUi'
import { tablesDataExtension } from '../dataExtension'
import { openQueryValue } from '../query/queryValue'
import { queryProp } from '../schema'

const current = vi.hoisted(() => ({ui: undefined as Block | undefined}))
vi.mock('@/data/globalState', () => ({useUIStateBlock: () => current.ui!}))

const workspaceId = 'ws-outside-query'
const options = {scope: ChangeScope.BlockDefault}
const SCOPE = 'outline'
const NONE: string[] = []

let db: TestDb
let repo: Repo
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
afterEach(async () => {
  cleanup()
  await repo.awaitProcessors()
})
beforeEach(async () => {
  await resetTestDb(db.db)
  await db.db.execute(
    `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time, encryption_mode, properties_migration)
      VALUES (?, 'test', 'test-user', 1, 1, 'none', 'children')`, [workspaceId])
  ;({repo} = createTestRepo({db: db.db, extensions: [tablesDataExtension]}))
  repo.setActiveWorkspaceId(workspaceId)
  await repo.whenPropertyDefinitionsReady(workspaceId)
  await repo.tx(async tx => {
    for (const [id, parentId, orderKey] of [['ui', null, 'u'], ['host', null, 'h'], ['a', 'host', 'a0'], ['b', 'host', 'a1']] as const) {
      await tx.create({id, parentId, workspaceId, orderKey, content: id})
    }
  }, options)
  current.ui = repo.block('ui')
  await current.ui.load()
})

const setFocus = (blockId: string) => {
  const ui = current.ui!.peek()!
  repo.cache.setSnapshot({...ui, properties: {
    ...ui.properties,
    [focusedBlockLocationProp.name]: focusedBlockLocationProp.codec.encode({blockId, renderScopeId: SCOPE}),
  }})
}

describe('the host children outside the query', () => {
  it('drop a focused child the cache moved under a sibling before their own list reloads', async () => {
    setFocus('b')
    const {result} = renderHook(() => useOutsideQueryIds(repo.block('host'), SCOPE, NONE, NONE))
    await waitFor(() => expect(result.current).toEqual(['a', 'b']))
    act(() => {
      const b = repo.block('b').peek()!
      repo.cache.setSnapshot({...b, parentId: 'a', orderKey: 'a0'})
    })
    expect(repo.query.childIds({id: 'host', propertyChildren: 'none'}).peek()).toEqual(['a', 'b'])
    expect(result.current).toEqual(['a'])
  })

  it('leave out the query field row that holds the focused query', async () => {
    await materializePropertySeeds(repo, workspaceId, [queryProp])
    const valueId = await openQueryValue(repo, 'host', propertyDefinitionBlockId(workspaceId, queryProp.seedKey))
    const fieldRowId = repo.block(valueId).peek()?.parentId ?? (await repo.block(valueId).load())!.parentId!
    await repo.block(fieldRowId).load()
    await repo.query.ancestors({id: valueId}).load()
    setFocus(valueId)
    const {result} = renderHook(() => useOutsideQueryIds(repo.block('host'), SCOPE, NONE, NONE))
    await waitFor(() => expect(result.current).toEqual(['a', 'b']))
    expect(repo.block(fieldRowId).peek()?.isFieldForm).toBe(true)
  })

  it('keep a focused field-form child that the outline lists', async () => {
    await repo.tx(tx => tx.stampReferenceTarget('b', 'no-such-definition', true), options)
    await repo.query.ancestors({id: 'b'}).load()
    setFocus('b')
    const {result} = renderHook(() => useOutsideQueryIds(repo.block('host'), SCOPE, NONE, NONE))
    await waitFor(() => expect(repo.block('b').peek()?.isFieldForm).toBe(true))
    await waitFor(() => expect(result.current).toEqual(['a', 'b']))
  })
})
