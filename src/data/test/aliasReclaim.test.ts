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

/** A live block claiming `alias` that `repo.tx` could not have written — the
 *  shape sync-apply leaves, since the uniqueness trigger skips it. A raw insert
 *  still maintains `block_aliases`. */
const insertSynced = async (id: string, content: string, aliases: readonly string[], createdAt: number) => {
  await sharedDb.db.execute(
    `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json,
      references_json, created_at, updated_at, user_updated_at, created_by, updated_by, deleted)
     VALUES (?, ?, NULL, ?, ?, ?, '[]', ?, ?, ?, 'u', 'u', 0)`,
    [id, WS, `k-${id}`, content, JSON.stringify(bag(aliases)), createdAt, createdAt, createdAt],
  )
}

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
  // yielded in whatever shape it is stored, and nothing else in it is touched.
  it.each([
    {shape: 'a bare string', stored: 'Inbox', restored: undefined},
    {shape: 'an array with a non-string entry', stored: ['Inbox', 7, 'Mine'], restored: [7, 'Mine']},
    {shape: 'an object', stored: {a: 'Inbox', b: 'Mine'}, restored: {b: 'Mine'}},
  ])('restores a page whose bag is $shape with a taken name in it', async ({stored: storedBag, restored}) => {
    await sharedDb.db.execute(
      `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json,
        references_json, created_at, updated_at, user_updated_at, created_by, updated_by, deleted)
       VALUES (?, ?, NULL, 'a0', 'My Page', ?, '[]', 1, 1, 1, 'u', 'u', 1)`,
      [PAGE, WS, JSON.stringify({[aliasesProp.name]: storedBag})],
    )
    await createPage('q', 'Q', ['Inbox'], 'a1')

    await repo.mutate.restore({id: PAGE})

    const row = await sharedDb.db.get<{deleted: number; properties_json: string}>(
      'SELECT deleted, properties_json FROM blocks WHERE id = ?', [PAGE])
    expect(row.deleted).toBe(0)
    expect(JSON.parse(row.properties_json)[aliasesProp.name]).toEqual(restored)
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
