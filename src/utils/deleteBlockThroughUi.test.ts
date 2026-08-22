import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo, isBlockDeleted } from '@/data/test/createTestRepo'
import { ConfirmBulkDeleteDialog } from '@/components/ConfirmBulkDeleteDialog'
import {
  BULK_DELETE_CONFIRM_THRESHOLD,
  deleteBlockThroughUi,
  deleteBlocksThroughUi,
} from '@/utils/deleteBlockThroughUi'
import { __resetDialogsForTests, getDialogQueue } from '@/utils/dialogs'
import * as viewTransition from '@/utils/viewTransition'

const WS = 'ws-1'

let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  __resetDialogsForTests()
  repo = createTestRepo({db: sharedDb.db}).repo
  await repo.tx(async tx => {
    await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'r'})
  }, {scope: ChangeScope.BlockDefault})
})

afterEach(() => {
  __resetDialogsForTests()
  vi.restoreAllMocks()
})

/** `count` children of `parentId`, ids `<prefix>-0…`. */
const seedChildren = async (parentId: string, count: number, prefix: string): Promise<string[]> => {
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const id = `${prefix}-${i}`
    await repo.mutate.createChild({parentId, id, content: id})
    ids.push(id)
  }
  return ids
}

const pendingDialog = () => getDialogQueue().at(-1)

/** Answer the outstanding confirmation. `null` is the queue's cancel value. */
const answerDialog = (value: true | null): void => {
  const entry = pendingDialog()
  if (!entry) throw new Error('no dialog outstanding')
  entry.finalize(value)
}

describe('bulk-delete confirmation', () => {
  it('deletes a small selection without asking', async () => {
    const ids = await seedChildren('root', BULK_DELETE_CONFIRM_THRESHOLD - 1, 'small')

    expect(await deleteBlocksThroughUi(ids.map(id => repo.block(id)))).toBe(true)

    expect(getDialogQueue()).toHaveLength(0)
    expect(await isBlockDeleted(repo, ids[0])).toBe(true)
  })

  it('asks before deleting a selection at the threshold, and deletes nothing until answered', async () => {
    const ids = await seedChildren('root', BULK_DELETE_CONFIRM_THRESHOLD, 'many')

    const deleting = deleteBlocksThroughUi(ids.map(id => repo.block(id)))
    await vi.waitFor(() => expect(pendingDialog()?.Component).toBe(ConfirmBulkDeleteDialog))
    // The whole point: nothing is tombstoned while the question is on screen.
    expect(await isBlockDeleted(repo, ids[0])).toBe(false)

    expect(pendingDialog()?.props).toEqual({
      targetCount: BULK_DELETE_CONFIRM_THRESHOLD,
      totalCount: BULK_DELETE_CONFIRM_THRESHOLD,
    })
    answerDialog(true)

    expect(await deleting).toBe(true)
    for (const id of ids) expect(await isBlockDeleted(repo, id)).toBe(true)
  })

  it('cancelling deletes nothing and reports the delete did not happen', async () => {
    const ids = await seedChildren('root', BULK_DELETE_CONFIRM_THRESHOLD, 'many')

    const deleting = deleteBlocksThroughUi(ids.map(id => repo.block(id)))
    await vi.waitFor(() => expect(pendingDialog()).toBeDefined())
    answerDialog(null)

    expect(await deleting).toBe(false)
    for (const id of ids) expect(await isBlockDeleted(repo, id)).toBe(false)
  })

  it('counts the subtree, not the selection — one collapsed page still asks', async () => {
    // The case the gesture can least see coming, and the reason the count is
    // not `blocks.length`: a single target whose delete cascades over a large
    // subtree.
    await repo.mutate.createChild({parentId: 'root', id: 'page', content: 'page'})
    await seedChildren('page', BULK_DELETE_CONFIRM_THRESHOLD - 1, 'child')

    const deleting = deleteBlockThroughUi(repo.block('page'))
    await vi.waitFor(() => expect(pendingDialog()).toBeDefined())
    expect(pendingDialog()?.props).toEqual({
      targetCount: 1,
      totalCount: BULK_DELETE_CONFIRM_THRESHOLD,
    })
    answerDialog(true)

    expect(await deleting).toBe(true)
    expect(await isBlockDeleted(repo, 'child-0')).toBe(true)
  })

  it('counts a block and its own descendant once', async () => {
    // A selection can hold both; the delete visits each row once, so the
    // number the user is shown has to as well.
    await repo.mutate.createChild({parentId: 'root', id: 'parent', content: 'parent'})
    await repo.mutate.createChild({parentId: 'parent', id: 'kid', content: 'kid'})

    expect(await deleteBlocksThroughUi([repo.block('parent'), repo.block('kid')])).toBe(true)
    // 2 affected blocks, not 3 — below the threshold, so no dialog at all.
    expect(getDialogQueue()).toHaveLength(0)
  })

  it('asks BEFORE starting the view transition', async () => {
    // A dialog opened inside `startViewTransition`'s callback renders under the
    // frozen page snapshot, where it can never be clicked — the gesture would
    // hang on a promise the user cannot resolve. Ordering is owned by the choke
    // point precisely so no caller can reintroduce that.
    const seen: string[] = []
    vi.spyOn(viewTransition, 'withMoveTransition').mockImplementation(async run => {
      seen.push(`transition:${getDialogQueue().length} pending`)
      await run()
    })
    const ids = await seedChildren('root', BULK_DELETE_CONFIRM_THRESHOLD, 'many')

    const deleting = deleteBlocksThroughUi(ids.map(id => repo.block(id)), {animate: true})
    await vi.waitFor(() => expect(pendingDialog()).toBeDefined())
    expect(seen).toEqual([])
    answerDialog(true)

    await deleting
    expect(seen).toEqual(['transition:0 pending'])
  })

  it('skips the ask for a caller that already confirmed', async () => {
    const ids = await seedChildren('root', BULK_DELETE_CONFIRM_THRESHOLD, 'many')

    expect(await deleteBlocksThroughUi(ids.map(id => repo.block(id)), {alreadyConfirmed: true}))
      .toBe(true)

    expect(getDialogQueue()).toHaveLength(0)
    expect(await isBlockDeleted(repo, ids[0])).toBe(true)
  })
})
