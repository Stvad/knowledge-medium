import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { showPropertiesProp } from '@/data/properties'
import { consumePendingPropertyCreateRequest } from '@/utils/propertyNavigation'
import { convertEmptyChildBlockToProperty } from '@/utils/propertyCreation'

describe('convertEmptyChildBlockToProperty', () => {
  let sharedDb: TestDb
  let h: TestDb
  let repo: Repo

  beforeAll(async () => { sharedDb = await createTestDb() })
  afterAll(async () => { await sharedDb.cleanup() })
  beforeEach(async () => {
    await resetTestDb(sharedDb.db)
    h = sharedDb
    repo = createTestRepo({
      db: h.db,
      user: {id: 'user-1'},
      newId: () => crypto.randomUUID(),
      startSyncObserver: false,
    }).repo

    await repo.tx(async tx => {
      await tx.create({
        id: 'parent',
        workspaceId: 'ws-1',
        parentId: null,
        orderKey: 'a0',
        content: 'Parent',
      })
      await tx.create({
        id: 'child',
        workspaceId: 'ws-1',
        parentId: 'parent',
        orderKey: 'a0',
      })
    }, {scope: ChangeScope.BlockDefault, description: 'create property conversion fixture'})
  })

  afterEach(async () => {
    consumePendingPropertyCreateRequest('parent')
  })

  it('turns an empty child block into a pending property creation on its parent', async () => {
    const converted = await convertEmptyChildBlockToProperty(repo.block('child'), repo)

    expect(converted).toBe(true)
    expect(repo.block('parent').peekProperty(showPropertiesProp)).toBe(true)
    expect(consumePendingPropertyCreateRequest('parent')).toMatchObject({
      blockId: 'parent',
      initialName: '',
    })
    expect(repo.block('child').peek()).toBeNull()
    expect(repo.block('child').peekRaw()?.deleted).toBe(true)
  })

  it('does not convert a block that owns child content', async () => {
    await repo.mutate.createChild({parentId: 'child', id: 'grandchild'})

    const converted = await convertEmptyChildBlockToProperty(repo.block('child'), repo)

    expect(converted).toBe(false)
    expect(repo.block('parent').peekProperty(showPropertiesProp)).toBeUndefined()
    expect(repo.block('child').peek()?.deleted).toBe(false)
  })

  it('does not convert a block that owns property content (would delete its data)', async () => {
    // A block with properties but empty content and no VISIBLE children. In a
    // child-backed workspace its property field/value rows are hidden from the
    // visible childIds facade the guard reads, so converting would `delete()`
    // the block and strand/soft-delete that property data (incl. value-row
    // comments). Guarding on the properties cell is flip-independent — the same
    // block in a non-flipped workspace holds the data in its cell and must be
    // protected too.
    await repo.tx(tx => tx.update('child', {properties: {note: 'kept'}}),
      {scope: ChangeScope.BlockDefault})

    const converted = await convertEmptyChildBlockToProperty(repo.block('child'), repo)

    expect(converted).toBe(false)
    expect(repo.block('parent').peekProperty(showPropertiesProp)).toBeUndefined()
    expect(repo.block('child').peek()?.deleted).toBe(false)
  })
})
