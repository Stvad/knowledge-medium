// @vitest-environment happy-dom
/**
 * The multi-select indent / outdent / move up / move down handlers, run as
 * production builds them (`getDefaultActionGroups`) on the test DB. The
 * selection is handed over in the order a panel stores it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, type User } from '@/data/api'
import { Repo } from '@/data/repo.js'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb.js'
import { createTestRepo } from '@/data/test/createTestRepo'
import { keyAtEnd } from '@/data/orderKey.js'
import { getDefaultActionGroups } from '@/shortcuts/defaultShortcuts.js'
import type { ActionTrigger, MultiSelectModeDependencies } from '@/shortcuts/types.js'

const WS = 'ws-1'
const USER: User = {id: 'user-1'}
/** The panel's scope root. It sits behind a sibling and under a parent so an
 *  indent or outdent that wrongly reaches it has somewhere to put it. */
const ROOT = 'root'

let sharedDb: TestDb
let repo: Repo

beforeAll(async () => {
  sharedDb = await createTestDb()
  // Run as a reduced-motion user. No rows render here, so the move gestures'
  // row slide would otherwise wait out its settle timeout on every move.
  vi.spyOn(window, 'matchMedia').mockImplementation(query =>
    ({matches: query === '(prefers-reduced-motion: reduce)'}) as MediaQueryList)
})
afterAll(async () => {
  vi.restoreAllMocks()
  await sharedDb.cleanup()
})

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: USER}).repo
  repo.setActiveWorkspaceId(WS)
  // Listed in order: each row lands after its earlier siblings.
  const tree: Array<[id: string, parentId: string | null]> = [
    ['outer', null],
    ['before', 'outer'],
    [ROOT, 'outer'],
    ['r1', ROOT],
    ['r2', ROOT],
    ['r2a', 'r2'],
    ['r2b', 'r2'],
    ['r3', ROOT],
    ['r4', ROOT],
    // Another page, which this panel doesn't render.
    ['other', null],
    ['o', 'other'],
    ['o1', 'o'],
    ['o2', 'o'],
    ['o3', 'o'],
    ['panel', null],
  ]
  const lastKey = new Map<string | null, string>()
  await repo.tx(async tx => {
    for (const [id, parentId] of tree) {
      const orderKey = keyAtEnd(lastKey.get(parentId) ?? null)
      lastKey.set(parentId, orderKey)
      await tx.create({id, workspaceId: WS, parentId, orderKey, content: id})
    }
  }, {scope: ChangeScope.BlockDefault})
  repo.undoManager?.clear()
})

/** `id`'s subtree as `a b(c d) e`: children in order, nested in parentheses. */
const outline = async (id: string): Promise<string> => {
  const children = await sharedDb.db.getAll<{id: string}>(
    'SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id', [id])
  const parts = await Promise.all(children.map(async child => {
    const inner = await outline(child.id)
    return inner ? `${child.id}(${inner})` : child.id
  }))
  return parts.join(' ')
}

const INITIAL = 'r1 r2(r2a r2b) r3 r4'

type Gesture = 'indent_block' | 'outdent_block' | 'move_block_up' | 'move_block_down'

/** Run the multi-select variant of `gesture` over `selectedIds`, in that order. */
const run = async (gesture: Gesture, selectedIds: string[]): Promise<void> => {
  const action = getDefaultActionGroups({repo}).multiSelectModeActions
    .find(each => each.id === `multi_select.${gesture}`)
  if (!action) throw new Error(`no multi_select.${gesture}`)
  const deps: MultiSelectModeDependencies = {
    selectedBlocks: selectedIds.map(id => repo.block(id)),
    anchorBlock: null,
    uiStateBlock: repo.block('panel'),
    scopeRootId: ROOT,
  }
  await action.handler(deps, {} as ActionTrigger)
}

describe('multi-select outline gestures move the selection as a group', () => {
  it.each<[Gesture, string[], string]>([
    ['move_block_up', ['r3', 'r4'], 'r1 r3 r4 r2(r2a r2b)'],
    ['move_block_down', ['r1', 'r2'], 'r3 r1 r2(r2a r2b) r4'],
    ['indent_block', ['r3', 'r4'], 'r1 r2(r2a r2b r3 r4)'],
    ['outdent_block', ['r2a', 'r2b'], 'r1 r2 r2a r2b r3 r4'],
    // First children enter the previous parent's subtree, last children the next's.
    ['move_block_up', ['r2a', 'r2b'], 'r1(r2a r2b) r2 r3 r4'],
    ['move_block_down', ['r2a', 'r2b'], 'r1 r2 r3(r2a r2b) r4'],
  ])('%s over %j keeps the run in order', async (gesture, selection, expected) => {
    await run(gesture, selection)
    expect(await outline(ROOT)).toBe(expected)
  })

  it.each<[Gesture, string[]]>([
    ['move_block_up', ['r1', 'r2']],
    ['move_block_down', ['r3', 'r4']],
    ['indent_block', ['r1', 'r2']],
    ['indent_block', ['r2a', 'r2b']],
  ])('%s over %j leaves a run whose leading block cannot move where it is', async (gesture, selection) => {
    await run(gesture, selection)
    expect(await outline(ROOT)).toBe(INITIAL)
  })

  it.each<[Gesture, string[], string]>([
    ['indent_block', ['r4', 'r3'], 'r1 r2(r2a r2b r3 r4)'],
    ['move_block_down', ['r2', 'r1'], 'r3 r1 r2(r2a r2b) r4'],
  ])('%s over %j applies in tree order, not the order the selection stored', async (gesture, selection, expected) => {
    await run(gesture, selection)
    expect(await outline(ROOT)).toBe(expected)
  })

  it.each<[Gesture, string, string]>([
    ['indent_block', 'r3', 'r1 r2(r2a r2b r3) r4'],
    ['outdent_block', 'r2b', 'r1 r2(r2a) r2b r3 r4'],
    ['move_block_up', 'r3', 'r1 r3 r2(r2a r2b) r4'],
    ['move_block_down', 'r3', 'r1 r2(r2a r2b) r4 r3'],
  ])('%s skips a selected row from outside the panel and still moves %s', async (gesture, inPanel, expected) => {
    await run(gesture, [inPanel, 'o2'])
    expect(await outline(ROOT)).toBe(expected)
    expect(await outline('other')).toBe('o(o1 o2 o3)')
  })

  it.each<Gesture>(['indent_block', 'outdent_block', 'move_block_up', 'move_block_down'])(
    '%s never relocates the scope root itself',
    async gesture => {
      await run(gesture, [ROOT])
      expect(await outline('outer')).toBe(`before ${ROOT}(${INITIAL})`)
    },
  )

  it.each<[Gesture, string[]]>([
    ['indent_block', ['r3', 'r4']],
    ['outdent_block', ['r2a', 'r2b']],
    ['move_block_up', ['r3', 'r4']],
    ['move_block_down', ['r1', 'r2']],
  ])('one undo reverts %s over the whole selection', async (gesture, selection) => {
    await run(gesture, selection)
    expect(await outline(ROOT)).not.toBe(INITIAL)

    expect(await repo.undo()).toBe(true)
    expect(await outline(ROOT)).toBe(INITIAL)
  })
})
