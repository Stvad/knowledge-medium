import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import { showPropertiesProp } from '@/data/properties'
import { consumePendingPropertyCreateRequest } from '@/utils/propertyNavigation'
import { convertEmptyChildBlockToProperty } from '@/utils/propertyCreation'

describe('convertEmptyChildBlockToProperty', () => {
  let h: TestDb
  let repo: Repo

  beforeEach(async () => {
    h = await createTestDb()
    let now = 1700_000_000_000
    let txSeq = 0
    repo = new Repo({
      db: h.db,
      cache: new BlockCache(),
      user: {id: 'user-1'},
      now: () => ++now,
      newId: () => crypto.randomUUID(),
      newTxSeq: () => ++txSeq,
      startRowEventsTail: false,
    })

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
    await h.cleanup()
  })

  it('turns an empty child block into a pending property creation on its parent', async () => {
    const converted = await convertEmptyChildBlockToProperty(repo.block('child'), repo)

    expect(converted).toBe(true)
    expect(repo.block('parent').peekProperty(showPropertiesProp)).toBe(true)
    expect(consumePendingPropertyCreateRequest('parent')).toMatchObject({
      blockId: 'parent',
      initialName: '',
    })
    expect(repo.block('child').peek()?.deleted).toBe(true)
  })

  it('does not convert a block that owns child content', async () => {
    await repo.mutate.createChild({parentId: 'child', id: 'grandchild'})

    const converted = await convertEmptyChildBlockToProperty(repo.block('child'), repo)

    expect(converted).toBe(false)
    expect(repo.block('parent').peekProperty(showPropertiesProp)).toBeUndefined()
    expect(repo.block('child').peek()?.deleted).toBe(false)
  })
})
