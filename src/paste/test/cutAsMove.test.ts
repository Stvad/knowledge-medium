// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { isCollapsedProp } from '@/data/properties'
import { Repo } from '@/data/repo'
import { armCut, disarmCut, getArmedCut, undoOrTakeBackCut } from '../armedCut'
import { pasteArmedCut, pasteFromClipboard } from '../operations'

const WS = 'ws-1'
const CUT_TEXT = '- cut text'

let sharedDb: TestDb
let repo: Repo
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}}).repo
  repo.setActiveWorkspaceId(WS)
  disarmCut()
})
afterEach(() => vi.unstubAllGlobals())

const createBlock = (
  id: string,
  content: string,
  parentId: string | null,
  orderKey: string,
  properties: Record<string, unknown> = {},
): Promise<unknown> =>
  repo.tx(tx => tx.create({id, workspaceId: WS, parentId, orderKey, content, properties}),
    {scope: ChangeScope.BlockDefault})

const childIds = async (parentId: string): Promise<string[]> =>
  (await repo.query.children({id: parentId}).load()).map(row => row.id)

const parentOf = async (id: string): Promise<string | null | undefined> =>
  (await repo.block(id).load())?.parentId

const arm = (rootIds: string[], workspaceId = WS) => armCut(CUT_TEXT, {workspaceId, rootIds})

/** page: a, b, x (x has child x1), y */
const seedPage = async () => {
  await createBlock('page', 'Page', null, 'a0')
  await createBlock('a', 'A', 'page', 'a0')
  await createBlock('a1', 'A1', 'a', 'a0')
  await createBlock('b', 'B', 'page', 'a1')
  await createBlock('x', 'X', 'page', 'a2')
  await createBlock('x1', 'X1', 'x', 'a0')
  await createBlock('y', 'Y', 'page', 'a3')
}

describe('pasteArmedCut', () => {
  it('moves the cut blocks themselves, in order, keeping their subtrees', async () => {
    await seedPage()
    await arm(['a', 'b'])

    const outcome = await pasteArmedCut(CUT_TEXT, repo.block('y'), repo, {scopeRootId: 'page'})

    expect(outcome).toMatchObject({kind: 'moved'})
    expect(outcome?.kind === 'moved' && outcome.blocks.map(block => block.id)).toEqual(['a', 'b'])
    expect(await childIds('page')).toEqual(['x', 'y', 'a', 'b'])
    expect(await childIds('a')).toEqual(['a1'])
  })

  it('is one undo step', async () => {
    await seedPage()
    await arm(['a', 'b'])
    repo.undoManager.clear()
    await pasteArmedCut(CUT_TEXT, repo.block('y'), repo, {scopeRootId: 'page'})

    expect(await repo.undo()).toBe(true)
    expect(await childIds('page')).toEqual(['a', 'b', 'x', 'y'])
  })

  it('stays armed after a move: after an undo, pasting again moves the originals, never copies them', async () => {
    await seedPage()
    await arm(['a'])
    await pasteArmedCut(CUT_TEXT, repo.block('y'), repo, {scopeRootId: 'page'})
    expect(await repo.undo()).toBe(true)
    expect(await childIds('page')).toEqual(['a', 'b', 'x', 'y'])

    const again = await pasteArmedCut(CUT_TEXT, repo.block('x'), repo, {scopeRootId: 'page', placement: 'sibling'})

    expect(again?.kind).toBe('moved')
    expect(await childIds('page')).toEqual(['b', 'x', 'a', 'y'])
    expect(getArmedCut()?.pasted).toBe(true)
  })

  it('never duplicates when two pastes overlap', async () => {
    await seedPage()
    await arm(['a'])

    await Promise.all([
      pasteArmedCut(CUT_TEXT, repo.block('y'), repo, {scopeRootId: 'page'}),
      pasteArmedCut(CUT_TEXT, repo.block('b'), repo, {scopeRootId: 'page', placement: 'sibling'}),
    ])

    const ids = await childIds('page')
    expect([...ids].sort()).toEqual(['a', 'b', 'x', 'y'])
  })

  it('is not a cut when the clipboard holds other text, and disarms', async () => {
    await seedPage()
    await arm(['a'])

    expect(await pasteArmedCut('- something else', repo.block('y'), repo)).toBeNull()
    expect(getArmedCut()).toBeNull()
    expect(await childIds('page')).toEqual(['a', 'b', 'x', 'y'])
  })

  it('does not move across workspaces, and keeps the cut armed', async () => {
    await seedPage()
    await arm(['a'], 'ws-other')

    expect(await pasteArmedCut(CUT_TEXT, repo.block('y'), repo)).toBeNull()
    expect(getArmedCut()).not.toBeNull()
  })

  it('refuses a paste inside the cut blocks rather than pasting copies there', async () => {
    await seedPage()
    await arm(['a', 'b'])

    expect(await pasteArmedCut(CUT_TEXT, repo.block('a1'), repo)).toEqual({kind: 'refused'})
    expect(await pasteArmedCut(CUT_TEXT, repo.block('a'), repo)).toEqual({kind: 'refused'})
    // Beside a cut block: no cycle for core.move to catch, so only the
    // explicit check refuses it rather than reporting a move of nothing.
    expect(await pasteArmedCut(CUT_TEXT, repo.block('b'), repo, {placement: 'sibling'}))
      .toEqual({kind: 'refused'})
    expect(await childIds('page')).toEqual(['a', 'b', 'x', 'y'])
    expect(getArmedCut()).not.toBeNull()
  })

  it('moves the roots that still exist when some were deleted since the cut', async () => {
    await seedPage()
    await arm(['a', 'b'])
    await repo.mutate.delete({id: 'a'})

    await pasteArmedCut(CUT_TEXT, repo.block('y'), repo, {scopeRootId: 'page'})

    expect(await childIds('page')).toEqual(['x', 'y', 'b'])
  })

  it('falls back to an ordinary paste when every cut block was deleted', async () => {
    await seedPage()
    await arm(['a'])
    await repo.mutate.delete({id: 'a'})

    expect(await pasteArmedCut(CUT_TEXT, repo.block('y'), repo)).toBeNull()
    expect(getArmedCut()).toBeNull()
  })

  it('moves only the ancestor when a root has become a descendant of another', async () => {
    await seedPage()
    await arm(['a', 'b'])
    await repo.mutate.move({id: 'b', parentId: 'a', position: {kind: 'last'}})

    await pasteArmedCut(CUT_TEXT, repo.block('y'), repo, {scopeRootId: 'page'})

    expect(await childIds('page')).toEqual(['x', 'y', 'a'])
    expect(await childIds('a')).toEqual(['a1', 'b'])
  })

  it('takes the place of a blank, childless target', async () => {
    await seedPage()
    await createBlock('blank', '', 'page', 'a4')
    await arm(['a'])

    await pasteArmedCut(CUT_TEXT, repo.block('blank'), repo, {scopeRootId: 'page'})

    expect(await childIds('page')).toEqual(['b', 'x', 'y', 'a'])
    const row = await repo.db.getOptional<{deleted: number}>('SELECT deleted FROM blocks WHERE id = ?', ['blank'])
    expect(row?.deleted).toBe(1)
  })

  it('never replaces a blank target that other blocks reference', async () => {
    await seedPage()
    await createBlock('blank', '', 'page', 'a4')
    await repo.tx(tx => tx.create({
      id: 'referrer', workspaceId: WS, parentId: 'page', orderKey: 'a5',
      content: 'see ((blank))', references: [{id: 'blank', alias: 'blank'}],
    }), {scope: ChangeScope.BlockDefault})
    await arm(['a'])

    await pasteArmedCut(CUT_TEXT, repo.block('blank'), repo, {scopeRootId: 'page'})

    expect(await childIds('page')).toEqual(['b', 'x', 'y', 'blank', 'a', 'referrer'])
    expect((await repo.block('referrer').load())?.content).toBe('see ((blank))')
  })

  it('keeps a blank target that carries properties', async () => {
    await seedPage()
    await createBlock('blank', '', 'page', 'a4', {[isCollapsedProp.name]: true})
    await arm(['a'])

    await pasteArmedCut(CUT_TEXT, repo.block('blank'), repo, {scopeRootId: 'page'})

    expect(await childIds('page')).toEqual(['b', 'x', 'y', 'blank', 'a'])
  })

  it('"after" an expanded block with children is its first child (visible placement)', async () => {
    await seedPage()
    await arm(['a'])

    await pasteArmedCut(CUT_TEXT, repo.block('x'), repo, {scopeRootId: 'page'})

    expect(await childIds('x')).toEqual(['a', 'x1'])
  })

  it('sibling placement keeps the move beside the target', async () => {
    await seedPage()
    await arm(['a'])

    await pasteArmedCut(CUT_TEXT, repo.block('x'), repo, {scopeRootId: 'page', placement: 'sibling'})

    expect(await parentOf('a')).toBe('page')
    expect(await childIds('page')).toEqual(['b', 'x', 'a', 'y'])
  })

  it('lands inside a zoomed-in scope root, and reveals it', async () => {
    await seedPage()
    await repo.block('x').set(isCollapsedProp, true)
    await arm(['a'])

    await pasteArmedCut(CUT_TEXT, repo.block('x'), repo, {scopeRootId: 'x', position: 'before'})

    expect(await childIds('x')).toEqual(['a', 'x1'])
    expect((await repo.block('x').load())?.properties[isCollapsedProp.name]).toBe(false)
  })
})

describe('undoOrTakeBackCut', () => {
  const armWithUndoTop = () =>
    armCut(CUT_TEXT, {workspaceId: WS, rootIds: ['a'], undoTop: repo.undoManager.peekUndo(ChangeScope.BlockDefault)})

  it('right after a cut, takes the cut back instead of undoing the edit before it', async () => {
    await seedPage()
    await repo.mutate.setContent({id: 'b', content: 'B edited'})
    await armWithUndoTop()

    expect(await undoOrTakeBackCut(repo)).toBe(true)

    expect(getArmedCut()).toBeNull()
    expect((await repo.block('b').load())?.content).toBe('B edited')
  })

  it('undoes as usual once something was edited after the cut', async () => {
    await seedPage()
    await armWithUndoTop()
    await repo.mutate.setContent({id: 'b', content: 'B edited'})

    await undoOrTakeBackCut(repo)

    expect((await repo.block('b').load())?.content).toBe('B')
    expect(getArmedCut()).not.toBeNull()
  })

  it('undoes a paste of the cut first, then takes the cut back', async () => {
    await seedPage()
    await armWithUndoTop()
    await pasteArmedCut(CUT_TEXT, repo.block('y'), repo, {scopeRootId: 'page'})

    await undoOrTakeBackCut(repo)
    expect(await childIds('page')).toEqual(['a', 'b', 'x', 'y'])
    expect(getArmedCut()).not.toBeNull()

    await undoOrTakeBackCut(repo)
    expect(getArmedCut()).toBeNull()
  })
})

describe('pasteFromClipboard (vim p, multi-select p)', () => {
  it('completes an armed cut instead of pasting its text', async () => {
    await seedPage()
    await arm(['a'])
    vi.stubGlobal('navigator', {clipboard: {readText: async () => CUT_TEXT}})

    const pasted = await pasteFromClipboard(repo.block('y'), repo, {scopeRootId: 'page'})

    expect(pasted.map(block => block.id)).toEqual(['a'])
    expect(await childIds('page')).toEqual(['b', 'x', 'y', 'a'])
  })
})
