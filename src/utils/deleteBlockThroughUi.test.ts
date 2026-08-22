import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { blockDeletionGuardsFacet } from '@/extensions/core'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { resolveFacetRuntimeSync } from '@/facets/facet'
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
    // A selection can hold both; the delete visits each row once, so the count
    // has to as well. Sized so double-counting the overlap crosses the
    // threshold and deduping does not: the subtree is one short of it, and the
    // child is picked up a second time by being selected in its own right.
    await repo.mutate.createChild({parentId: 'root', id: 'parent', content: 'parent'})
    const kids = await seedChildren('parent', BULK_DELETE_CONFIRM_THRESHOLD - 2, 'kid')

    expect(await deleteBlocksThroughUi([repo.block('parent'), repo.block(kids[0])])).toBe(true)

    expect(getDialogQueue()).toHaveLength(0)
    expect(await isBlockDeleted(repo, kids[0])).toBe(true)
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

  it('re-resolves the guards after the dialog, not just before it', async () => {
    // The dialog is human-scale time: a sync landing a daily-note type on a
    // target while it is open would otherwise be waved through by a guard pass
    // that finished before the question was even asked.
    const ids = await seedChildren('root', BULK_DELETE_CONFIRM_THRESHOLD, 'many')

    const deleting = deleteBlocksThroughUi(ids.map(id => repo.block(id)))
    await vi.waitFor(() => expect(pendingDialog()).toBeDefined())
    // setFacetRuntime REPLACES the registries, so the kernel data contribution
    // has to be re-included or `core.subtree` stops resolving.
    repo.setFacetRuntime(resolveFacetRuntimeSync([
      kernelDataExtension,
      blockDeletionGuardsFacet.of(
        block => (block.id === ids[3] ? 'Nope.' : null),
        {source: 'test'},
      ),
    ]))
    answerDialog(true)

    expect(await deleting).toBe(false)
    for (const id of ids) expect(await isBlockDeleted(repo, id)).toBe(false)
  })

  it('queries each subtree once when a selection spans a parent and its children', async () => {
    // An outline range over an expanded parent is the ordinary way to select
    // both. One query, not one per selected block.
    await repo.mutate.createChild({parentId: 'root', id: 'parent', content: 'parent'})
    const kids = await seedChildren('parent', BULK_DELETE_CONFIRM_THRESHOLD, 'kid')
    const runQuery = vi.spyOn(repo, 'runQuery')

    // Selection order: the parent, then its children, as the outline shows them.
    const deleting = deleteBlocksThroughUi(
      [repo.block('parent'), ...kids.map(id => repo.block(id))],
    )
    await vi.waitFor(() => expect(pendingDialog()).toBeDefined())
    answerDialog(true)
    await deleting

    expect(runQuery.mock.calls.filter(([name]) => name === 'core.subtree')).toHaveLength(1)
  })

  it('skips the ask for a caller that already confirmed', async () => {
    const ids = await seedChildren('root', BULK_DELETE_CONFIRM_THRESHOLD, 'many')

    expect(await deleteBlocksThroughUi(ids.map(id => repo.block(id)), {alreadyConfirmed: true}))
      .toBe(true)

    expect(getDialogQueue()).toHaveLength(0)
    expect(await isBlockDeleted(repo, ids[0])).toBe(true)
  })
})
