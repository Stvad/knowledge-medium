// @vitest-environment node
/**
 * Writes that assert an alias another live block holds. Two rules, one per
 * cause of the wedge:
 *
 *   - a name a block already holds is not a new claim, so keeping it never
 *     aborts — even when a synced block co-claims it (#185);
 *   - a revival nobody asked to claim with (restore, undo / redo) yields a
 *     name taken while the block was dead instead of aborting (#883).
 *
 * A new claim the user asked for is still refused; `collisionRejection.test.ts`
 * covers that side.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { aliasesProp } from '@/data/properties'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'
import { aliasDataExtension } from '@/plugins/alias/dataExtension.js'
import { referencesDataExtension } from '@/plugins/references/dataExtension.js'

const WS = 'ws-1'
// `((id))` only parses as a block-ref when the id is UUID-shaped.
const PAGE = '11111111-1111-4111-8111-111111111111'

let sharedDb: TestDb
let repo: Repo
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    extensions: [referencesDataExtension, aliasDataExtension],
  }).repo
  repo.setActiveWorkspaceId(WS)
})

const bag = (aliases: readonly string[]) => ({[aliasesProp.name]: aliasesProp.codec.encode([...aliases])})

/** A row written the way sync-apply writes one: raw, so the uniqueness trigger
 *  skips it — it can co-claim a name, or be a malformed tombstone or a stray
 *  value child that `repo.tx` would never leave — while `block_aliases` is
 *  still maintained. */
const insertRaw = async ({id, content, properties = {}, parentId = null, orderKey = `k-${id}`, createdAt = 1, deleted = false}: {
  id: string
  content: string
  properties?: Record<string, unknown>
  parentId?: string | null
  orderKey?: string
  createdAt?: number
  deleted?: boolean
}) => {
  await sharedDb.db.execute(
    `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json,
      references_json, created_at, updated_at, user_updated_at, created_by, updated_by, deleted)
     VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, 'sync', 'sync', ?)`,
    [id, WS, parentId, orderKey, content, JSON.stringify(properties), createdAt, createdAt, createdAt, deleted ? 1 : 0],
  )
}

const insertSynced = (id: string, content: string, aliases: readonly string[], createdAt: number) =>
  insertRaw({id, content, properties: bag(aliases), createdAt})

const createPage = (id: string, content: string, aliases: readonly string[], orderKey = 'a0') =>
  repo.tx(
    tx => tx.create({id, workspaceId: WS, parentId: null, orderKey, content, properties: bag(aliases)}),
    {scope: ChangeScope.BlockDefault},
  )

const holders = async (alias: string): Promise<string[]> =>
  (await sharedDb.db.getAll<{block_id: string}>(
    'SELECT block_id FROM block_aliases WHERE workspace_id = ? AND alias = ? ORDER BY block_id',
    [WS, alias],
  )).map(row => row.block_id)

const stored = async (id: string) => {
  const row = await sharedDb.db.get<{deleted: number; content: string; properties_json: string}>(
    'SELECT deleted, content, properties_json FROM blocks WHERE id = ?',
    [id],
  )
  return {
    deleted: row.deleted === 1,
    content: row.content,
    aliases: (JSON.parse(row.properties_json)[aliasesProp.name] ?? []) as string[],
  }
}

describe('a name a block already holds is not a new claim (#185)', () => {
  beforeEach(async () => {
    await insertSynced('x', 'X', ['foo'], 1_000)
    await insertSynced('y', 'Y', ['foo'], 2_000)
  })

  it('commits a property write on a block that co-claims a synced name', async () => {
    await repo.tx(async tx => {
      const x = await tx.get('x')
      await tx.update('x', {properties: {...x!.properties, 'test:note': 'kept'}})
    }, {scope: ChangeScope.BlockDefault})

    expect(JSON.parse((await sharedDb.db.get<{p: string}>(
      'SELECT properties_json AS p FROM blocks WHERE id = ?', ['x'])).p)['test:note']).toBe('kept')
    expect(await holders('foo')).toEqual(['x', 'y'])
  })

  it('commits a title edit on a block that co-claims a synced name', async () => {
    await repo.mutate.setContent({id: 'x', content: 'X renamed'})

    expect(await stored('x')).toMatchObject({content: 'X renamed', aliases: ['foo', 'X renamed']})
    expect(await holders('foo')).toEqual(['x', 'y'])
  })

  it('commits a new free name beside the co-claimed one', async () => {
    await repo.mutate.setProperty({id: 'x', schema: aliasesProp, value: ['foo', 'bar']})

    expect(await holders('bar')).toEqual(['x'])
    expect(await holders('foo')).toEqual(['x', 'y'])
  })

  it('restores a deleted co-claimant without the name the other still holds', async () => {
    await repo.mutate.delete({id: 'x'})
    await repo.mutate.restore({id: 'x'})

    expect(await stored('x')).toMatchObject({deleted: false, aliases: []})
    expect(await holders('foo')).toEqual(['y'])
  })
})

describe('a revival yields a name taken while the block was dead (#883)', () => {
  it('restores a page whose name another page took', async () => {
    await createPage(PAGE, 'My Page', ['My Page', 'Inbox'])
    await repo.mutate.delete({id: PAGE})
    await createPage('q', 'Q', ['Q', 'Inbox'], 'a1')

    await repo.mutate.restore({id: PAGE})

    expect(await stored(PAGE)).toMatchObject({deleted: false, aliases: ['My Page']})
    expect(await holders('Inbox')).toEqual(['q'])
  })

  // The trigger indexes text from a malformed bag too, so a taken name is
  // found in whatever shape it is stored; the names left come back as a list.
  it.each([
    {shape: 'a bare string', stored: 'Inbox', restored: []},
    {shape: 'an array with a non-string entry', stored: ['Inbox', 7, 'Mine'], restored: ['Mine']},
    {shape: 'an object', stored: {a: 'Inbox', b: 'Mine'}, restored: ['Mine']},
  ])('restores a page whose bag is $shape with a taken name in it', async ({stored: storedBag, restored}) => {
    await insertRaw({id: PAGE, content: 'My Page', properties: {[aliasesProp.name]: storedBag}, deleted: true})
    await createPage('q', 'Q', ['Inbox'], 'a1')

    await repo.mutate.restore({id: PAGE})

    expect(await stored(PAGE)).toMatchObject({deleted: false, aliases: restored})
    expect(await holders('Inbox')).toEqual(['q'])
  })

  it('undoes the delete of a page whose name a synced block took', async () => {
    await createPage(PAGE, 'My Page', ['My Page', 'Inbox'])
    await repo.awaitProcessors()
    await repo.mutate.delete({id: PAGE})
    await insertSynced('q', 'Q', ['Inbox'], 5_000)

    expect(await repo.undo()).toBe(true)

    expect(await stored(PAGE)).toMatchObject({deleted: false, aliases: ['My Page']})
    expect(await holders('Inbox')).toEqual(['q'])
  })

  it('undoes the delete of a page with children whose name a synced block took', async () => {
    await createPage(PAGE, 'My Page', ['My Page', 'Inbox'])
    await repo.tx(
      tx => tx.create({id: 'child', workspaceId: WS, parentId: PAGE, orderKey: 'a0', content: 'note'}),
      {scope: ChangeScope.BlockDefault},
    )
    await repo.awaitProcessors()
    await repo.mutate.delete({id: PAGE})
    await insertSynced('q', 'Q', ['Inbox'], 5_000)

    expect(await repo.undo()).toBe(true)

    expect(await stored(PAGE)).toMatchObject({deleted: false, aliases: ['My Page']})
    expect((await stored('child')).deleted).toBe(false)
  })

  describe('when the delete\'s own cascade mints a seat for the name', () => {
    beforeEach(async () => {
      await createPage(PAGE, 'My Page', ['My Page', 'Inbox'])
      await repo.awaitProcessors()
      // Deleting PAGE inlines `((PAGE))` here, and the re-parse that follows
      // finds no live `Inbox` — so it mints a seat that claims it.
      await repo.tx(
        tx => tx.create({id: 'r', workspaceId: WS, parentId: null, orderKey: 'a1', content: `see [[Inbox]] and ((${PAGE}))`}),
        {scope: ChangeScope.BlockDefault},
      )
      await repo.awaitProcessors()
      await repo.mutate.delete({id: PAGE})
      await repo.awaitProcessors()
      const [seat] = await holders('Inbox')
      expect(seat).not.toBe(PAGE)
    })

    it('undoes the delete', async () => {
      expect(await repo.undo()).toBe(true)
      expect(await stored(PAGE)).toMatchObject({deleted: false, aliases: ['My Page']})
    })

    it('restores the page', async () => {
      await repo.mutate.restore({id: PAGE})
      expect(await stored(PAGE)).toMatchObject({deleted: false, aliases: ['My Page']})
    })
  })
})

// Past the properties flip the alias list also lives as a field row with one
// value child per name, and those children are the source of truth. A yielded
// name has to leave them too, or the next projection hands it back to the cell.
describe('a revival yields in a workspace whose properties are child blocks', () => {
  beforeEach(async () => {
    await sharedDb.db.execute(
      `INSERT INTO workspaces
         (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
       VALUES (?, 'test ws', 'user-1', 1, 1, 'none', NULL, 'children')`,
      [WS],
    )
  })

  /** The names the owner's live alias value children carry. */
  const aliasChildren = async (ownerId: string): Promise<string[]> => {
    const resolution = repo.propertySchemaResolverFor(WS).resolve(aliasesProp.name)
    if (resolution.status !== 'resolved') throw new Error('alias property does not resolve')
    const {fieldId} = resolution.schema
    return (await sharedDb.db.getAll<{content: string}>(
      `SELECT v.content FROM blocks f JOIN blocks v ON v.parent_id = f.id
       WHERE f.parent_id = ? AND f.reference_target_id = ? AND f.deleted = 0
         AND v.deleted = 0 AND v.is_field_form IS NOT 1
       ORDER BY v.order_key`,
      [ownerId, fieldId],
    )).map(row => row.content)
  }

  const pageWithChildren = async () => {
    await repo.tx(async tx => {
      await tx.create({id: PAGE, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'My Page'})
      await tx.setProperty(PAGE, aliasesProp, ['My Page', 'Inbox'])
    }, {scope: ChangeScope.BlockDefault})
    await repo.awaitProcessors()
    expect(await aliasChildren(PAGE)).toEqual(['My Page', 'Inbox'])
  }

  it('restores a page whose name another page took', async () => {
    await pageWithChildren()
    await repo.mutate.delete({id: PAGE})
    await createPage('q', 'Q', ['Q', 'Inbox'], 'a1')

    await repo.mutate.restore({id: PAGE})

    expect(await stored(PAGE)).toMatchObject({deleted: false, aliases: ['My Page']})
    expect(await aliasChildren(PAGE)).toEqual(['My Page'])
  })

  it('undoes the delete of a page whose name a synced block took', async () => {
    await pageWithChildren()
    await repo.mutate.delete({id: PAGE})
    await insertSynced('q', 'Q', ['Inbox'], 5_000)

    expect(await repo.undo()).toBe(true)

    expect(await stored(PAGE)).toMatchObject({deleted: false, aliases: ['My Page']})
    expect(await aliasChildren(PAGE)).toEqual(['My Page'])
  })

  it('undoes a delete without touching a member the entry never wrote', async () => {
    await pageWithChildren()
    await repo.mutate.delete({id: PAGE})
    // A peer that missed the delete adds a member under the dead page's field
    // row. The undo's snapshot cell knows nothing of it.
    const resolution = repo.propertySchemaResolverFor(WS).resolve(aliasesProp.name)
    if (resolution.status !== 'resolved') throw new Error('alias property does not resolve')
    const field = await sharedDb.db.get<{id: string}>(
      'SELECT id FROM blocks WHERE parent_id = ? AND reference_target_id = ?',
      [PAGE, resolution.schema.fieldId],
    )
    await insertRaw({id: 'peer-member', content: 'Peer', parentId: field.id, orderKey: 'z'})
    await insertSynced('q', 'Q', ['Inbox'], 5_000)

    expect(await repo.undo()).toBe(true)

    expect(await aliasChildren(PAGE)).toEqual(['My Page', 'Peer'])
  })

  it('restores a page without touching a member a peer wrote while it was dead', async () => {
    await pageWithChildren()
    await repo.mutate.delete({id: PAGE})
    // A peer that missed the delete still holds the field row and its values
    // live, and adds a member. Sync-apply lands it under the tombstoned page;
    // the page's own cell knows nothing of it.
    const resolution = repo.propertySchemaResolverFor(WS).resolve(aliasesProp.name)
    if (resolution.status !== 'resolved') throw new Error('alias property does not resolve')
    const field = await sharedDb.db.get<{id: string}>(
      'SELECT id FROM blocks WHERE parent_id = ? AND reference_target_id = ?',
      [PAGE, resolution.schema.fieldId],
    )
    await sharedDb.db.execute('UPDATE blocks SET deleted = 0 WHERE id = ? OR parent_id = ?', [field.id, field.id])
    await insertRaw({id: 'peer-member', content: 'Peer', parentId: field.id, orderKey: 'z'})
    await createPage('q', 'Q', ['Q', 'Inbox'], 'a1')

    await repo.mutate.restore({id: PAGE})

    expect(await stored(PAGE)).toMatchObject({deleted: false, aliases: ['My Page', 'Peer']})
    expect(await aliasChildren(PAGE)).toEqual(['My Page', 'Peer'])
  })

  it('restores a malformed bag with a taken name in it', async () => {
    await insertRaw({id: PAGE, content: 'My Page', properties: {[aliasesProp.name]: ['Inbox', 7, 'Mine']}, deleted: true})
    await createPage('q', 'Q', ['Inbox'], 'a1')

    await repo.mutate.restore({id: PAGE})

    expect(await stored(PAGE)).toMatchObject({deleted: false, aliases: ['Mine']})
    expect(await aliasChildren(PAGE)).toEqual(['Mine'])
  })
})

describe('undo replay yields only to a holder that keeps the name', () => {
  it('revives both co-claimants of a deleted subtree, the second yielding their shared name', async () => {
    await createPage('root', 'Root', [])
    await insertSynced('x', 'X', ['foo'], 1_000)
    await insertSynced('y', 'Y', ['foo'], 2_000)
    await repo.tx(async tx => {
      await tx.move('x', {parentId: 'root', orderKey: 'a0'})
      await tx.move('y', {parentId: 'root', orderKey: 'a1'})
    }, {scope: ChangeScope.BlockDefault})
    await repo.mutate.delete({id: 'root'})

    expect(await repo.undo()).toBe(true)

    const [x, y] = [await stored('x'), await stored('y')]
    expect([x.deleted, y.deleted]).toEqual([false, false])
    expect(await holders('foo')).toHaveLength(1)
    expect([...x.aliases, ...y.aliases]).toEqual(['foo'])
  })

  it('yields neither name when an undone swap only blocks itself', async () => {
    await createPage('a', 'A', ['foo'])
    await createPage('b', 'B', ['bar'], 'a1')
    await repo.tx(async tx => {
      await tx.setProperty('a', aliasesProp, ['tmp'])
      await tx.setProperty('b', aliasesProp, ['foo'])
      await tx.setProperty('a', aliasesProp, ['bar'])
    }, {scope: ChangeScope.BlockDefault})

    // Each restored row wants the name the other still holds, and both hold
    // theirs only until their own write. Yielding here would lose a name that
    // was never contested from outside; the replay fails as a whole instead.
    await expect(repo.undo()).rejects.toThrow()
    expect(await holders('foo')).toEqual(['b'])
    expect(await holders('bar')).toEqual(['a'])
  })
})
