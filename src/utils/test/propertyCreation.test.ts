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

  it('does not convert a block whose only children are HIDDEN property rows with an empty cell', async () => {
    // The state a forced find-replace / broken value-row edit leaves in a
    // child-backed workspace: a live field row + value child under `child`, but
    // PROJECT has dropped the cell key because the value stopped decoding. The
    // visible childIds facade hides the field row (§9) AND `data.properties` is
    // empty, so both the cell guard and a visible-only child check would pass —
    // the STRUCTURAL child list is what protects the field/value rows (and any
    // value-row comments) from being subtree-deleted by the conversion.
    const FIELD_DEF = '99999999-9999-4999-8999-999999999999'
    await h.db.execute(
      `INSERT OR REPLACE INTO workspaces
         (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
       VALUES ('ws-1', 'ws', 'user-1', 1, 1, 'none', NULL, 'children')`,
    )
    await repo.tx(async tx => {
      await tx.create({
        id: FIELD_DEF, workspaceId: 'ws-1', parentId: null, orderKey: 'zz',
        content: 'note', properties: {types: ['property-schema']},
      })
      await tx.create({
        id: 'field', workspaceId: 'ws-1', parentId: 'child',
        referenceTargetId: FIELD_DEF, orderKey: 'a0', content: `((${FIELD_DEF}))`,
      })
      await tx.create({
        id: 'value', workspaceId: 'ws-1', parentId: 'field', orderKey: 'a0',
        content: 'kept',
      })
    }, {scope: ChangeScope.BlockDefault})

    // The field row is hidden from the visible facade and the cell is empty:
    // exactly the both-look-empty state the fix must still refuse.
    expect(await repo.block('child').childIds.load()).toEqual([])
    expect(repo.block('child').peek()?.properties).toEqual({})

    const converted = await convertEmptyChildBlockToProperty(repo.block('child'), repo)

    expect(converted).toBe(false)
    expect(repo.block('child').peek()?.deleted).toBe(false)
    expect(repo.block('field').peek()?.deleted).toBe(false)
    expect(repo.block('value').peek()?.deleted).toBe(false)
  })
})
