import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { blockDeletionGuardsFacet } from '@/extensions/core'
import { __resetEditModeKeepaliveForTests, resolveEditModeKeepalive } from '@/components/editModeKeepalive'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import type { Repo } from '@/data/repo'
import { keysBetween } from '@/data/orderKey'
import { USER_SCHEMAS_PROJECTOR_ID } from '@/data/userSchemasService'
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
import { waitFor } from '@/test/waitFor'

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

/** `count` children of a CHILDLESS `parentId`, ids `<prefix>-0…`, in one tx. */
const seedChildren = async (parentId: string, count: number, prefix: string): Promise<string[]> => {
  const ids = Array.from({length: count}, (_, i) => `${prefix}-${i}`)
  const orderKeys = keysBetween(null, null, count)
  await repo.tx(async tx => {
    for (const [i, id] of ids.entries()) {
      await tx.create({id, workspaceId: WS, parentId, orderKey: orderKeys[i], content: id})
    }
  }, {scope: ChangeScope.BlockDefault})
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
    await waitFor(() => expect(pendingDialog()?.Component).toBe(ConfirmBulkDeleteDialog))
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
    await waitFor(() => expect(pendingDialog()).toBeDefined())
    answerDialog(null)

    expect(await deleting).toBe(false)
    for (const id of ids) expect(await isBlockDeleted(repo, id)).toBe(false)
  })

  it('counts the subtree, not the selection — one collapsed page still asks', async () => {
    // Why the count is not `blocks.length`.
    await repo.mutate.createChild({parentId: 'root', id: 'page', content: 'page'})
    await seedChildren('page', BULK_DELETE_CONFIRM_THRESHOLD - 1, 'child')

    const deleting = deleteBlockThroughUi(repo.block('page'))
    await waitFor(() => expect(pendingDialog()).toBeDefined())
    expect(pendingDialog()?.props).toEqual({
      targetCount: 1,
      totalCount: BULK_DELETE_CONFIRM_THRESHOLD,
    })
    answerDialog(true)

    expect(await deleting).toBe(true)
    expect(await isBlockDeleted(repo, 'child-0')).toBe(true)
  })

  it('counts a block and its own descendant once', async () => {
    // Child-first order makes both subtree queries run. Counting their overlap
    // twice would push the delete to the threshold.
    await repo.mutate.createChild({parentId: 'root', id: 'parent', content: 'parent'})
    const kids = await seedChildren('parent', BULK_DELETE_CONFIRM_THRESHOLD - 2, 'kid')

    const stop = subscribeDialogs(() => pendingDialog()?.finalize(null))
    try {
      expect(await deleteBlocksThroughUi([repo.block(kids[0]), repo.block('parent')])).toBe(true)
    } finally {
      stop()
    }
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
    await waitFor(() => expect(pendingDialog()).toBeDefined())
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
    await waitFor(() => expect(pendingDialog()).toBeDefined())
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
    await waitFor(() => expect(pendingDialog()).toBeDefined())
    answerDialog(true)
    await deleting

    expect(runQuery.mock.calls.filter(([name]) => name === 'core.subtree')).toHaveLength(1)
  })

  const seedPropertyBranch = async (descendantCount: number): Promise<string[]> => {
    repo.setActiveWorkspaceId(WS)
    await repo.projectors.handle(USER_SCHEMAS_PROJECTOR_ID)!.whenPrimed(WS)
    await repo.tx(async tx => {
      await tx.create({
        id: 'def', workspaceId: WS, parentId: null, orderKey: 'b0', content: 'a property',
        properties: {types: ['property-schema'], 'property-schema:name': 'note', 'property-schema:preset': 'string'},
      })
      await tx.create({
        id: 'field', workspaceId: WS, parentId: 'root', orderKey: 'c0',
        content: '::((def))', referenceTargetId: 'def', isFieldForm: true,
      })
      await tx.create({id: 'value', workspaceId: WS, parentId: 'field', orderKey: 'a0', content: 'v'})
    }, {scope: ChangeScope.BlockDefault})
    await waitFor(() => expect(repo.propertyDefinitions?.definitionsByFieldId.has('def')).toBe(true))
    return seedChildren('value', descendantCount, 'comment')
  }

  it('deletes without asking when only an incidental property field row reaches the threshold', async () => {
    const children = await seedPropertyBranch(BULK_DELETE_CONFIRM_THRESHOLD - 3)
    const stop = subscribeDialogs(() => pendingDialog()?.finalize(null))
    try {
      expect(await deleteBlockThroughUi(repo.block('root'))).toBe(true)
    } finally {
      stop()
    }
    for (const id of ['root', 'field', 'value', ...children]) {
      expect(await isBlockDeleted(repo, id)).toBe(true)
    }
  })

  it.each([
    {scenario: 'values and authored descendants', targets: ['root']},
    {scenario: 'an explicitly selected field row', targets: ['root', 'field']},
  ])('counts $scenario toward the warning', async ({targets}) => {
    await seedPropertyBranch(BULK_DELETE_CONFIRM_THRESHOLD - targets.length - 1)

    const deleting = deleteBlocksThroughUi(targets.map(id => repo.block(id)))
    await waitFor(() => expect(pendingDialog()).toBeDefined())
    const props = pendingDialog()?.props
    answerDialog(null)
    expect(await deleting).toBe(false)
    expect(props).toEqual({targetCount: targets.length, totalCount: BULK_DELETE_CONFIRM_THRESHOLD})
  })

  it('keeps the editor in edit mode while the dialog holds focus', async () => {
    // Reached from Backspace on an emptied block, the dialog takes DOM focus off
    // a live CodeMirror editor, which the blur handler reads as "editing ended".
    const ids = await seedChildren('root', BULK_DELETE_CONFIRM_THRESHOLD, 'many')
    // The latch is process-global and each hold lingers past its dialog
    // closing, so every earlier test here leaves one behind. Drain first or
    // this reads someone else's hold and stays green with the keepalive gone.
    __resetEditModeKeepaliveForTests()
    expect(resolveEditModeKeepalive()).toBe('exit')

    const deleting = deleteBlocksThroughUi(ids.map(id => repo.block(id)))
    await waitFor(() => expect(pendingDialog()).toBeDefined())
    // 'yield', not 'refocus': snapping focus back to the editor would take it
    // off the dialog the user still has to answer.
    expect(resolveEditModeKeepalive()).toBe('yield')
    answerDialog(true)
    await deleting
  })

  // `beforeWrite` exists so a gesture's interstitial work (a focus target read
  // out of the doomed subtree) sits in the one window where it is correct.
  // Both edges are load-bearing.
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
      await waitFor(() => expect(pendingDialog()).toBeDefined())
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
      await waitFor(() => expect(pendingDialog()).toBeDefined())
      answerDialog(null)

      expect(await deleting).toBe(false)
      expect(beforeWrite).not.toHaveBeenCalled()
    })

    it('re-resolves the guards after it, not just before it', async () => {
      // Caller work awaits, so a guard can change its answer meanwhile.
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
    await waitFor(() => expect(pendingDialog()).toBeDefined())
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
