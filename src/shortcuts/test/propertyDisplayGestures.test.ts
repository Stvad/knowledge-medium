// @vitest-environment happy-dom
/**
 * The block actions hand the surface's property display scope to the gesture
 * mutators: a property row the surface draws is a neighbour or an anchor like
 * any block. Without the scope (mode `none`) the same gesture passes it by.
 *
 *   page
 *     owner
 *       a
 *       status::   (drawn in `non-hidden`) → draft
 *       b
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, seedProperty, type BlockData, type User } from '@/data/api'
import { definitionSeedsFacet } from '@/data/facets'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import type { PropertyDisplayScopeLevels } from '@/data/propertyDisplayMode'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { bindBlockActionContext, createSharedBlockActions, type BlockAction } from '@/shortcuts/blockActions'
import { ActionContextTypes, type BlockShortcutDependencies, type MultiSelectModeDependencies } from '@/shortcuts/types'
import { applyToAllBlocksInSelection } from '@/shortcuts/utils'
import { getDefaultActionGroups } from '@/shortcuts/defaultShortcuts'

const USER: User = {id: 'user-1', name: 'Alice'}
const WS = 'ws-property-display-gestures'
const NON_HIDDEN: PropertyDisplayScopeLevels = {childBacked: true, workspace: 'non-hidden', panel: 'inherit'}

const statusProp = seedProperty({
  seedKey: 'test/property/display-gesture-status', revision: 1, name: 'display-gesture:status',
  preset: 'string', defaultValue: '', changeScope: ChangeScope.BlockDefault,
})

let sharedDb: TestDb
let repo: Repo
let statusRow: string
let draftRow: string
beforeAll(async () => {
  sharedDb = await createTestDb()
  // Reduced motion: no rows render here, so a move's row slide would wait out
  // its settle timeout.
  vi.spyOn(window, 'matchMedia').mockImplementation(query =>
    ({matches: query === '(prefers-reduced-motion: reduce)'}) as MediaQueryList)
})
afterAll(async () => {
  vi.restoreAllMocks()
  await sharedDb.cleanup()
})

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  await sharedDb.db.execute(
    `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time,
       encryption_mode, wk_canary, properties_migration)
     VALUES (?, 'test ws', ?, 1, 1, 'none', NULL, 'children')`, [WS, USER.id])
  repo = createTestRepo({db: sharedDb.db, user: USER}).repo
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    definitionSeedsFacet.of(statusProp, {source: 'test'}),
  ]))
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'page'})
    await tx.create({id: 'owner', workspaceId: WS, parentId: 'page', orderKey: 'a0', content: 'owner'})
    await tx.create({id: 'a', workspaceId: WS, parentId: 'owner', orderKey: 'a0', content: 'a'})
    await tx.create({id: 'b', workspaceId: WS, parentId: 'owner', orderKey: 'a2', content: 'b'})
  }, {scope: ChangeScope.BlockDefault})
  await vi.waitFor(() => expect(repo.propertySchemas.has(statusProp.name)).toBe(true))
  await repo.block('owner').set(statusProp, 'draft')
  const children = await repo.runQuery('core.children', {id: 'owner'}) as BlockData[]
  statusRow = children.find(child => child.isFieldForm)!.id
  await repo.tx(tx => tx.move(statusRow, {parentId: 'owner', orderKey: 'a1'}), {scope: ChangeScope.BlockDefault})
  draftRow = (await childIds(statusRow))[0]!
})

const parentOf = async (id: string): Promise<string | null> => (await repo.load(id))?.parentId ?? null
async function childIds(id: string): Promise<string[]> { return await repo.runQuery('core.childIds', {id}) as string[] }

const run = async (
  action: BlockAction,
  subject: string,
  propertyDisplay: PropertyDisplayScopeLevels | undefined,
): Promise<void> => {
  const deps: BlockShortcutDependencies = {
    block: repo.block(subject), uiStateBlock: repo.block('page'), scopeRootId: 'page', propertyDisplay,
  }
  await action.handler(deps, {kind: 'test'} as never)
}

describe('the block actions pass their surface\'s display scope', () => {
  it('move up swaps with the drawn property row', async () => {
    const {moveBlockUp} = createSharedBlockActions({repo})
    await run(moveBlockUp, 'b', NON_HIDDEN)
    expect(await childIds('owner')).toEqual(['a', 'b', statusRow])
  })

  it('indent nests under the drawn property row', async () => {
    const {indentBlock} = createSharedBlockActions({repo})
    await run(indentBlock, 'b', NON_HIDDEN)
    expect(await parentOf('b')).toBe(statusRow)
  })

  it('outdent anchors on the drawn property row', async () => {
    // The value's parent is the field row: absent from the mode-none list, it
    // is no anchor there, and the outdent does nothing.
    const {outdentBlock} = createSharedBlockActions({repo})
    await run(outdentBlock, draftRow, undefined)
    expect(await parentOf(draftRow)).toBe(statusRow)
    await run(outdentBlock, draftRow, NON_HIDDEN)
    expect(await parentOf(draftRow)).toBe('owner')
  })

  it('every block of a selection', async () => {
    const {indentBlock} = createSharedBlockActions({repo})
    const indent = applyToAllBlocksInSelection(bindBlockActionContext(ActionContextTypes.NORMAL_MODE, indentBlock))
    const deps: MultiSelectModeDependencies = {
      selectedBlocks: [repo.block('b')], anchorBlock: null,
      uiStateBlock: repo.block('page'), scopeRootId: 'page', propertyDisplay: NON_HIDDEN,
    }
    await indent.handler(deps, {kind: 'test'} as never)
    expect(await parentOf('b')).toBe(statusRow)
  })
})

describe('the multi-select gestures move the selection on the drawn list', () => {
  type Gesture = 'indent_block' | 'outdent_block' | 'move_block_up' | 'move_block_down'
  /** `status` and `draft` stand for the property row and its value. */
  const named = (id: string): string => id === statusRow ? 'status' : id === draftRow ? 'draft' : id
  const resolve = (name: string): string => name === 'status' ? statusRow : name === 'draft' ? draftRow : name
  const outline = async (id: string): Promise<string> => {
    const parts = await Promise.all((await childIds(id)).map(async child => {
      const inner = await outline(child)
      return inner ? `${named(child)}(${inner})` : named(child)
    }))
    return parts.join(' ')
  }

  it.each<[Gesture, string[], PropertyDisplayScopeLevels | undefined, string]>([
    ['indent_block', ['b'], NON_HIDDEN, 'a status(draft b)'],
    ['outdent_block', ['draft'], NON_HIDDEN, 'a status draft b'],
    ['move_block_up', ['b'], NON_HIDDEN, 'a b status(draft)'],
    ['move_block_down', ['a'], NON_HIDDEN, 'status(draft) a b'],
    // Without the property row drawn, a and b are a run that holds at the edge;
    // drawn, it stands between them, and b indents on its own.
    ['indent_block', ['a', 'b'], undefined, 'a status(draft) b'],
    ['indent_block', ['a', 'b'], NON_HIDDEN, 'a status(draft b)'],
  ])('%s over %j in scope %o', async (gesture, selection, propertyDisplay, expected) => {
    const action = getDefaultActionGroups({repo}).multiSelectModeActions
      .find(each => each.id === `multi_select.${gesture}`)
    if (!action) throw new Error(`no multi_select.${gesture}`)
    const deps: MultiSelectModeDependencies = {
      selectedBlocks: selection.map(name => repo.block(resolve(name))), anchorBlock: null,
      uiStateBlock: repo.block('page'), scopeRootId: 'page', propertyDisplay,
    }
    await action.handler(deps, {kind: 'test'} as never)
    expect(await outline('owner')).toBe(expected)
  })
})
