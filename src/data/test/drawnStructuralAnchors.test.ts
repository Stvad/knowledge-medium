// @vitest-environment happy-dom
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { blockChangeCursor } from '@/data/blockChangeCursor'
import { syncBulkLoadScope } from '@/data/internals/clientSchema'
import { listingSurfaceOf } from '@/data/childrenView'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { HTML_DOCUMENT_TYPE } from '@/data/blockTypes'
import { typesProp } from '@/data/properties'
import { mergeCheck, mergeUp } from '@/shortcuts/blockMergeGesture'

let db: TestDb
let repo: Repo
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => {
  await resetTestDb(db.db)
  ;({repo} = createTestRepo({db: db.db}))
  repo.setActiveWorkspaceId('ws')
  await repo.tx(async tx => {
    for (const [id, parentId, orderKey] of [
      ['owner', null, 'a0'], ['outside', null, 'a1'], ['ui', null, 'a2'],
      ['a', 'owner', 'a0'], ['b', 'owner', 'a1'], ['note', 'a', 'a0'], ['second', 'a', 'a1'],
    ] as const) await tx.create({id, parentId, orderKey, workspaceId: 'ws', content: id})
  }, {scope: ChangeScope.BlockDefault})
})

const rows = () => db.db.getAll('SELECT id, parent_id, order_key, deleted, content FROM blocks ORDER BY id')
const moveAway = (id: string) => repo.mutate.move({id, parentId: 'outside', position: {kind: 'last'}})
const anchor = {parentId: 'owner', siblingId: 'a'}
const cursor = () => blockChangeCursor(repo.db)

it('refuses an anchored indent after a bulk download inserts an unlogged neighbour', async () => {
  const changeCursor = await cursor()
  await db.db.writeTransaction(async tx => {
    await tx.execute('UPDATE tx_context SET source = NULL, scope = ? WHERE id = 1', [syncBulkLoadScope(['ws'])])
    await tx.execute(`INSERT INTO blocks (id, parent_id, order_key, workspace_id, created_at, updated_at, created_by, updated_by)
      VALUES ('downloaded', 'owner', 'a0V', 'ws', 1, 1, 'user', 'user')`)
    await tx.execute('UPDATE tx_context SET scope = NULL WHERE id = 1')
  })
  expect(await db.db.getAll("SELECT id FROM row_events WHERE block_id = 'downloaded'")).toEqual([])
  const before = await rows()
  await repo.mutate.indent({id: 'b', anchor: {...anchor, changeCursor}})
  expect(await rows()).toEqual(before)
})

it.each(['move', 'delete'] as const)('indent preserves every row after its drawn sibling undergoes %s', async change => {
  if (change === 'move') await moveAway('a')
  else await repo.mutate.delete({id: 'a'})
  const before = await rows()
  await repo.mutate.indent({id: 'b', anchor: {...anchor, changeCursor: await cursor()}})
  expect(await rows()).toEqual(before)
})

it('outdent refuses when the note or its parent has left the drawn list', async () => {
  await moveAway('a')
  const before = await rows()
  expect(await repo.mutate.outdent({id: 'note', anchor: {...anchor, changeCursor: await cursor()}})).toBe(false)
  expect(await repo.mutate.outdent({id: 'b', anchor: {changeCursor: await cursor(), parentId: 'outside', siblingId: 'a'}})).toBe(false)
  expect(await rows()).toEqual(before)
})

it('moving a tombstoned subject preserves its tombstone and every sibling', async () => {
  await repo.mutate.delete({id: 'b'})
  const before = await rows()
  expect(await repo.mutate.moveVertical({id: 'b', direction: -1, anchor: {...anchor, changeCursor: await cursor()}})).toBe(false)
  expect(await rows()).toEqual(before)
})

it('move between parents refuses after the former parent changed lists', async () => {
  await moveAway('a')
  const before = await rows()
  expect(await repo.mutate.moveVertical({id: 'note', direction: 1,
    anchor: {changeCursor: await cursor(), parentId: 'owner', fromParentId: 'a', siblingId: 'b'}})).toBe(false)
  expect(await rows()).toEqual(before)
})

it('two notes still sharing a parent cannot follow it out of the result', async () => {
  await moveAway('a')
  const before = await rows()
  await repo.mutate.indent({id: 'second', anchor: {changeCursor: await cursor(), parentId: 'a', siblingId: 'note', boundaryId: 'owner'}})
  expect(await rows()).toEqual(before)
})

it.each(['b', 'a', 'note'])('Backspace preserves the text and tree after %s moved away from the drawn merge', async id => {
  await moveAway(id)
  const before = await rows()
  expect(await mergeUp({
    from: repo.block('b'), into: repo.block('note'), liveContent: 'changed in editor',
    surface: listingSurfaceOf({}), uiStateBlock: repo.block('ui'), anchor,
  })).toBe(false)
  expect(await rows()).toEqual(before)
})

it('moving the merge destination within its preceding sibling invalidates the captured edge', async () => {
  const current = await mergeCheck(repo.block('b'), repo.block('note'), listingSurfaceOf({}), anchor)
  await repo.mutate.move({id: 'note', parentId: 'second', position: {kind: 'last'}})
  expect(await repo.tx(tx => current!(tx), {scope: ChangeScope.BlockDefault})).toBe(false)
})

it('a note moved to another sibling under the same owner no longer belongs to the drawn merge anchor', async () => {
  await repo.mutate.createChild({id: 'third', parentId: 'owner'})
  await repo.mutate.move({id: 'note', parentId: 'third', position: {kind: 'last'}})
  const before = await rows()
  expect(await mergeUp({from: repo.block('b'), into: repo.block('note'), liveContent: 'edited',
    surface: listingSurfaceOf({}), uiStateBlock: repo.block('ui'), anchor})).toBe(false)
  expect(await rows()).toEqual(before)
})

it('an empty member can be removed beside a source block without folding its text or values into code', async () => {
  await repo.block('a').set(typesProp, [HTML_DOCUMENT_TYPE])
  expect(await mergeUp({from: repo.block('b'), into: repo.block('a'), liveContent: '',
    surface: listingSurfaceOf({}), uiStateBlock: repo.block('ui'), anchor})).toBe(true)
  expect(await repo.load('b')).toBeNull()
  expect(await repo.load('a')).toMatchObject({parentId: 'owner', content: 'a'})
  expect(await repo.load('note')).toMatchObject({parentId: 'a'})
})

it('an empty member gaining a child before the delete keeps both stored rows alive', async () => {
  const source = repo.block('b')
  let added: Promise<string | null> | undefined
  expect(await mergeUp({from: source, into: repo.block('note'), liveContent: '', surface: listingSurfaceOf({}),
    uiStateBlock: repo.block('ui'), anchor, onTaken: () => {
      added = repo.mutate.createChild({id: 'kept', parentId: 'b'})
    }})).toBe(false)
  await added
  expect(await source.load()).toMatchObject({parentId: 'owner'})
  expect(await repo.load('kept')).toMatchObject({parentId: 'b'})
})

it('a previous descendant cannot follow its whole branch onto another page during an outline merge', async () => {
  const current = await mergeCheck(repo.block('b'), repo.block('note'), listingSurfaceOf({}))
  await moveAway('a')
  expect(await repo.tx(tx => current!(tx), {scope: ChangeScope.BlockDefault})).toBe(false)
})

it('a preceding row folded under another local row is no longer a merge sibling', async () => {
  await repo.mutate.createChild({id: 'third', parentId: 'owner'})
  await repo.mutate.move({id: 'a', parentId: 'third', position: {kind: 'last'}})
  const before = await rows()
  expect(await mergeUp({from: repo.block('b'), into: repo.block('note'), liveContent: 'edited',
    surface: listingSurfaceOf({}), uiStateBlock: repo.block('ui'), anchor})).toBe(false)
  expect(await rows()).toEqual(before)
})
