// @vitest-environment node
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
import { childrenViewFacet, listingSurfaceOf } from '@/data/childrenView'
import { definitionSeedsFacet } from '@/data/facets'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import type { PropertyDisplayScopeLevels } from '@/data/propertyDisplayMode'
import { focusBlock } from '@/data/properties'
import type { Repo } from '@/data/repo'
import { insertDrawnBlock } from '@/data/structuralInsert'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { visibleChildIds } from '@/data/visibleChildren'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { bindBlockActionContext, createSharedBlockActions, type BlockAction } from '@/shortcuts/blockActions'
import { ActionContextTypes, type BlockShortcutDependencies, type MultiSelectModeDependencies } from '@/shortcuts/types'
import { applyToAllBlocksInSelection } from '@/shortcuts/utils'

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
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

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

const installDerivedFieldValues = () => repo.setRuntimeContributions(childrenViewFacet, 'test.derived-field-values', [({parent}) =>
  parent.id === statusRow && {
    id: 'test.derived-field-values',
    order: 'derived',
    read: () => ({load: async () => [draftRow], peek: () => [draftRow]}),
  }])

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

  it.each(['none', 'non-hidden'] as const)('derived outdent respects the %s property display', async workspace => {
    const propertyDisplay = {...NON_HIDDEN, workspace}
    const surface = listingSurfaceOf({propertyDisplay, scopeRootId: 'page'})
    installDerivedFieldValues()
    const placement = () => sharedDb.db.get<{parent_id: string; order_key: string}>(
      'SELECT parent_id, order_key FROM blocks WHERE id = ? AND deleted = 0', [draftRow],
    )
    const hidden = workspace === 'none'
    expect(await visibleChildIds(repo.block('owner'), surface)).toEqual(hidden ? ['a', 'b'] : ['a', statusRow, 'b'])
    const before = await placement()

    await run(createSharedBlockActions({repo}).outdentBlock, draftRow, propertyDisplay)

    if (hidden) {
      expect(await placement()).toEqual(before)
    } else {
      expect(await placement()).toMatchObject({parent_id: 'owner'})
      expect(await childIds('owner')).toEqual(['a', statusRow, draftRow, 'b'])
    }
  })

  it('empty Enter creates a sibling when the derived list’s field row is hidden', async () => {
    const block = repo.block(draftRow)
    await block.setContent('')
    installDerivedFieldValues()
    const scope = listingSurfaceOf({propertyDisplay: {...NON_HIDDEN, workspace: 'none'}, scopeRootId: 'page'})
    expect(await visibleChildIds(repo.block('owner'), scope)).toEqual(['a', 'b'])
    const storedChildren = () => sharedDb.db.getAll<{id: string; content: string; order_key: string}>(
      'SELECT id, content, order_key FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id', [statusRow],
    )
    const before = await storedChildren()
    expect(before).toMatchObject([{id: draftRow, content: ''}])

    const inserted = await insertDrawnBlock(block, scope, {kind: 'empty-enter'})

    expect(inserted).not.toBeNull()
    expect(await storedChildren()).toEqual([before[0], {id: inserted?.id, content: '', order_key: expect.any(String)}])
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

  it('uses the focused children view for every block in a bulk indent', async () => {
    await repo.tx(tx => tx.create({id: 'c', workspaceId: WS, parentId: 'owner', orderKey: 'a3', content: 'c'}),
      {scope: ChangeScope.BlockDefault})
    const renderScopeId = 'filtered-outline'
    repo.setRuntimeContributions(childrenViewFacet, 'test.bulk-indent', [({parent, surface}) =>
      parent.id === 'owner' && surface.renderScopeId === renderScopeId ? {
        id: 'test.bulk-indent',
        read: () => {
          const owned = repo.query.childIds({id: parent.id})
          const filtered = (ids: readonly string[]) => ['c', 'b', 'a'].filter(id => ids.includes(id))
          return {
            load: async () => filtered(await owned.load()),
            peek: () => {
              const ids = owned.peek()
              return ids && filtered(ids)
            },
          }
        },
      } : undefined])

    const uiStateBlock = repo.block('page')
    await focusBlock(uiStateBlock, 'a', {renderScopeId})
    const {indentBlock} = createSharedBlockActions({repo})
    const indent = applyToAllBlocksInSelection(bindBlockActionContext(ActionContextTypes.NORMAL_MODE, indentBlock))
    await indent.handler({
      selectedBlocks: [repo.block('b'), repo.block('a')], anchorBlock: repo.block('b'),
      uiStateBlock, scopeRootId: 'page', propertyDisplay: NON_HIDDEN,
    }, {kind: 'test'} as never)

    expect(await childIds('owner')).toEqual([statusRow, 'c'])
    expect(await childIds('c')).toEqual(['b', 'a'])
  })
})
