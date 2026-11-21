// @vitest-environment node
/**
 * Pins the scope-relative placement of vim `o` / `O` — the "invisible
 * block" bug as reported from a backlinks panel: pressing `o` on a
 * backlink entry created a SIBLING of the entry's shown block, which
 * lives outside the rendered subtree, so the block existed in the DB
 * with nowhere to show.
 *
 * The rule lives in `resolveStructuralEditPolicy`; these tests pin that
 * the two vim handlers actually consult it. They were the only
 * structural handlers not covered — `split_block_cm` (Enter) and
 * `indent_block` (Tab) are pinned in `defaultShortcuts.test.ts`, and
 * neither vim create action is in the `defaultActions.fuzz.test.ts`
 * pool, so removing the policy call here used to break nothing.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, type User } from '@/data/api'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { isCollapsedProp, peekFocusedBlockLocation } from '@/data/properties'
import { getVimNormalModeActions } from '../actions.ts'
import type { ActionTrigger, BlockShortcutDependencies } from '@/shortcuts/types'

const WS = 'ws-1'
const USER: User = {id: 'user-1', name: 'Alice'}
const UI = 'ui'
/** Outside the rendered subtree — a sibling created here is the bug. */
const OUTER = 'outer'
/** The block a backlink entry renders as the root of its subtree. */
const SHOWN = 'shown'

let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: USER}).repo
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: OUTER, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Outer'})
    await tx.create({id: UI, workspaceId: WS, parentId: null, orderKey: 'z0', content: 'UI'})
  }, {scope: ChangeScope.BlockDefault, description: 'seed scope-root fixture'})
  // `shown` is a child of OUTER in the real tree — it has a real parent
  // and can have real siblings; the surface just doesn't render them.
  await repo.mutate.createChild({parentId: OUTER, id: SHOWN, content: 'shown'})
})

const childIds = async (parentId: string): Promise<string[]> => {
  const rows = await sharedDb.db.getAll<{id: string}>(
    'SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id',
    [parentId],
  )
  return rows.map(row => row.id)
}

const trigger = {preventDefault: vi.fn()} as unknown as ActionTrigger

const dispatch = async (id: string, overrides: Partial<BlockShortcutDependencies> = {}) => {
  const action = getVimNormalModeActions({repo}).find(a => a.id === id)
  if (!action) throw new Error(`missing action: ${id}`)
  await action.handler({
    uiStateBlock: repo.block(UI),
    block: repo.block(SHOWN),
    scopeRootId: SHOWN,
    ...overrides,
  } as BlockShortcutDependencies, trigger)
}

describe('vim create-block placement at a render-scope root', () => {
  it('creates a first child, not an invisible sibling, when `o` is pressed on the scope root', async () => {
    await dispatch('create_block_below_and_edit')

    // The bug: a new sibling under OUTER, which the surface never renders.
    expect(await childIds(OUTER)).toEqual([SHOWN])
    const children = await childIds(SHOWN)
    expect(children).toHaveLength(1)
    // ...and the cursor follows it, so the user edits the block they see.
    expect(peekFocusedBlockLocation(repo.block(UI))?.blockId).toBe(children[0])
  })

  it('creates a first child, not an invisible sibling, when `O` is pressed on the scope root', async () => {
    await dispatch('create_block_above_and_edit')

    expect(await childIds(OUTER)).toEqual([SHOWN])
    const children = await childIds(SHOWN)
    expect(children).toHaveLength(1)
    expect(peekFocusedBlockLocation(repo.block(UI))?.blockId).toBe(children[0])
  })

  it('reveals a COLLAPSED scope root so the block `o` creates is visible', async () => {
    // A nested surface honours its root's collapse flag, so inserting a
    // first child under a collapsed root would hide the new block inside
    // a closed Collapsible — visible in the DB, invisible on screen.
    await repo.mutate.createChild({parentId: SHOWN, id: 'existing', content: 'existing'})
    await repo.mutate.setProperty({id: SHOWN, schema: isCollapsedProp, value: true})

    await dispatch('create_block_below_and_edit')

    expect(repo.block(SHOWN).peek()?.properties[isCollapsedProp.name]).toBe(false)
    const children = await childIds(SHOWN)
    expect(children).toHaveLength(2)
    expect(children[1]).toBe('existing')
  })

  it('still creates a plain sibling below when the block is NOT the scope root', async () => {
    // Guards against over-correcting the fix into "always child-first":
    // inside the surface, `o` on a childless block is an ordinary sibling.
    await repo.mutate.createChild({parentId: SHOWN, id: 'inner', content: 'inner'})

    await dispatch('create_block_below_and_edit', {block: repo.block('inner')})

    expect(await childIds('inner')).toEqual([])
    const children = await childIds(SHOWN)
    expect(children).toHaveLength(2)
    expect(children[0]).toBe('inner')
  })

  it('still creates a plain sibling above when the block is NOT the scope root', async () => {
    await repo.mutate.createChild({parentId: SHOWN, id: 'inner', content: 'inner'})

    await dispatch('create_block_above_and_edit', {block: repo.block('inner')})

    expect(await childIds('inner')).toEqual([])
    const children = await childIds(SHOWN)
    expect(children).toHaveLength(2)
    expect(children[1]).toBe('inner')
  })
})
