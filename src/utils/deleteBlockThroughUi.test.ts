import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { blockDeletionGuardsFacet } from '@/extensions/core'
import { resolveEditModeKeepalive } from '@/components/editModeKeepalive'
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
import { __resetDialogsForTests, getDialogQueue, subscribeDialogs } from '@/utils/dialogs'
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
    // Why the count is not `blocks.length`.
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
    // Owned by the choke point so no caller can reintroduce a dialog rendered
    // under the frozen snapshot, where it can never be clicked.
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

  it('refuses a guarded delete without asking about it first', async () => {
    // Both checks are present either way, so swapping them stays functionally
    // correct and silent: the user is put through a "Delete 21 blocks?"
    // question about a delete that was never going to happen.
    const ids = await seedChildren('root', BULK_DELETE_CONFIRM_THRESHOLD, 'many')
    repo.setFacetRuntime(resolveFacetRuntimeSync([
      kernelDataExtension,
      blockDeletionGuardsFacet.of(
        block => (block.id === ids[0] ? 'Nope.' : null),
        {source: 'test'},
      ),
    ]))

    // Answer anything that does appear, so a regression fails on the assertion
    // below rather than hanging: an unanswered dialog never settles the delete.
    const asked: string[] = []
    const stop = subscribeDialogs(() => {
      for (const entry of getDialogQueue()) {
        asked.push(String(entry.props.totalCount))
        entry.finalize(null)
      }
    })
    try {
      expect(await deleteBlocksThroughUi(ids.map(id => repo.block(id)))).toBe(false)
    } finally {
      stop()
    }
    expect(asked).toEqual([])
  })

  it('re-resolves the guards after the dialog, not just before it', async () => {
    // A sync landing a daily-note type while the dialog is open would otherwise
    // be waved through by a guard pass that ran before the question.
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

  it('counts authored descendants hanging under a property field row', async () => {
    // The visible view prunes the whole branch under a field row, comment
    // thread included; the delete takes them anyway. See `countBlocksRemovedBy`.
    await repo.tx(async tx => {
      await tx.create({
        id: 'def', workspaceId: WS, parentId: 'root', orderKey: 'b0', content: 'a property',
        properties: {types: ['property-schema']},
      })
      await tx.create({
        id: 'field', workspaceId: WS, parentId: 'root', orderKey: 'c0',
        content: '::((def))', referenceTargetId: 'def', isFieldForm: true,
      })
      await tx.create({id: 'value', workspaceId: WS, parentId: 'field', orderKey: 'a0', content: 'v'})
      // Authored content under the value — the part the visible view drops.
      for (let i = 0; i < BULK_DELETE_CONFIRM_THRESHOLD; i++) {
        await tx.create({
          id: `comment-${i}`, workspaceId: WS, parentId: 'value', orderKey: `a${i}`,
          content: `comment ${i}`,
        })
      }
    }, {scope: ChangeScope.BlockDefault})

    // Precondition: the field row really is recognized as machinery, or this
    // test proves nothing — the visible view would include the branch anyway.
    const visible = await repo.runQuery('core.subtree', {id: 'root', hidePropertyChildren: true})
    expect((visible as {id: string}[]).map(row => row.id)).not.toContain('comment-0')

    const deleting = deleteBlockThroughUi(repo.block('root'))
    await vi.waitFor(() => expect(pendingDialog()).toBeDefined())
    answerDialog(null)
    await deleting
  })

  it('keeps the editor in edit mode while the dialog holds focus', async () => {
    // Reached from Backspace on an emptied block, the dialog takes DOM focus off
    // a live CodeMirror editor, which the blur handler reads as "editing ended".
    const ids = await seedChildren('root', BULK_DELETE_CONFIRM_THRESHOLD, 'many')
    // The latch is process-global and each hold lingers 400ms past its dialog
    // closing, so every earlier test here leaves one behind. Drain first or
    // this reads someone else's hold and stays green with the keepalive gone.
    await vi.waitFor(
      () => expect(resolveEditModeKeepalive()).toBe('exit'),
      {timeout: 2000},
    )

    const deleting = deleteBlocksThroughUi(ids.map(id => repo.block(id)))
    await vi.waitFor(() => expect(pendingDialog()).toBeDefined())
    // 'yield', not 'refocus': snapping focus back to the editor would take it
    // off the dialog the user still has to answer.
    expect(resolveEditModeKeepalive()).toBe('yield')
    answerDialog(true)
    await deleting
  })

  // `beforeWrite` exists so a gesture's interstitial work (a cut's clipboard
  // write, a focus target read out of the doomed subtree) sits in the one
  // window where it is correct. Both edges are load-bearing.
  describe('beforeWrite', () => {
    it('runs after the question and before the write', async () => {
      const ids = await seedChildren('root', BULK_DELETE_CONFIRM_THRESHOLD, 'many')
      const seen: string[] = []

      const deleting = deleteBlocksThroughUi(ids.map(id => repo.block(id)), {
        beforeWrite: async () => {
          seen.push(`asked:${getDialogQueue().length} pending`)
          seen.push(`deleted:${await isBlockDeleted(repo, ids[0])}`)
        },
      })
      await vi.waitFor(() => expect(pendingDialog()).toBeDefined())
      expect(seen, 'not before the user has answered').toEqual([])
      answerDialog(true)
      await deleting

      // The dialog is gone by the time it runs, and nothing is tombstoned yet.
      expect(seen).toEqual(['asked:0 pending', 'deleted:false'])
    })

    it('does not run for a delete the user calls off', async () => {
      const ids = await seedChildren('root', BULK_DELETE_CONFIRM_THRESHOLD, 'many')
      const beforeWrite = vi.fn()

      const deleting = deleteBlocksThroughUi(ids.map(id => repo.block(id)), {beforeWrite})
      await vi.waitFor(() => expect(pendingDialog()).toBeDefined())
      answerDialog(null)

      expect(await deleting).toBe(false)
      expect(beforeWrite).not.toHaveBeenCalled()
    })

    it('re-resolves the guards after it, not just before it', async () => {
      // The cut path writes the clipboard in here: unbounded caller work, and
      // the pass this consolidation replaced used to sit after it.
      const ids = await seedChildren('root', 3, 'few')

      const deleted = await deleteBlocksThroughUi(ids.map(id => repo.block(id)), {
        beforeWrite: () => {
          repo.setFacetRuntime(resolveFacetRuntimeSync([
            kernelDataExtension,
            blockDeletionGuardsFacet.of(
              block => (block.id === ids[2] ? 'Nope.' : null),
              {source: 'test'},
            ),
          ]))
        },
      })

      expect(deleted).toBe(false)
      for (const id of ids) expect(await isBlockDeleted(repo, id)).toBe(false)
    })

    it('does not run for a delete a guard refuses', async () => {
      await repo.mutate.createChild({parentId: 'root', id: 'guarded', content: 'g'})
      repo.setFacetRuntime(resolveFacetRuntimeSync([
        kernelDataExtension,
        blockDeletionGuardsFacet.of(
          block => (block.id === 'guarded' ? 'Nope.' : null),
          {source: 'test'},
        ),
      ]))
      const beforeWrite = vi.fn()

      expect(await deleteBlockThroughUi(repo.block('guarded'), {beforeWrite})).toBe(false)
      expect(beforeWrite).not.toHaveBeenCalled()
    })
  })

  it('counts a repeated target once, in the dialog as well as the delete', async () => {
    // `run-action multi_select.delete_block` maps raw selectedBlockIds through,
    // so the same id can arrive more than once.
    await repo.mutate.createChild({parentId: 'root', id: 'page', content: 'page'})
    await seedChildren('page', BULK_DELETE_CONFIRM_THRESHOLD, 'kid')
    const repeated = Array.from({length: 25}, () => repo.block('page'))

    const deleting = deleteBlocksThroughUi(repeated)
    await vi.waitFor(() => expect(pendingDialog()).toBeDefined())
    expect(pendingDialog()?.props.targetCount).toBe(1)
    answerDialog(true)

    expect(await deleting).toBe(true)
  })

  it('deletes leaf-first whatever order the caller selected in', async () => {
    // Callers pass outline order; both the count's ancestor-first dedup and the
    // write's leaf-first order are derived here, so neither can be got wrong at
    // a call site.
    await repo.mutate.createChild({parentId: 'root', id: 'parent', content: 'parent'})
    await repo.mutate.createChild({parentId: 'parent', id: 'child', content: 'child'})
    const order: string[] = []
    // `repo.block(id)` is identity-stable, so spying the instance catches the
    // call the choke point actually makes.
    for (const id of ['parent', 'child']) {
      const block = repo.block(id)
      const real = block.delete.bind(block)
      vi.spyOn(block, 'delete').mockImplementation(async () => { order.push(id); await real() })
    }

    await deleteBlocksThroughUi([repo.block('parent'), repo.block('child')])

    expect(order).toEqual(['child', 'parent'])
  })
})
