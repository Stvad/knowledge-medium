// @vitest-environment happy-dom
/**
 * The outline skips opaque nested surfaces and enters nested surfaces
 * that supply their drawn rows. Merges refuse either kind of boundary.
 *
 *   page
 *     before
 *     host      draws [q, SURFACE] (its other data child is not drawn)
 *       q
 *       machinery
 *     bare      draws [SURFACE]
 *     after
 *     board     draws [c1, SURFACE, c2]
 *       c1
 *       c2
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { EditorView } from '@codemirror/view'
import { ChangeScope, defineQuery, type User } from '@/data/api'
import { childrenViewFacet, surfaceOwnerFacet, type DrawnChild } from '@/data/childrenView'
import { queriesFacet } from '@/data/facets'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { outlineSurfaceOf, type SurfaceCarrier } from '@/data/outlineSurface'
import { editorSelection, focusBlock, peekFocusedBlockLocation, selectionStateProp } from '@/data/properties'
import type { PropertyDisplayScopeLevels } from '@/data/propertyDisplayMode'
import type { Repo } from '@/data/repo'
import { blockDeletionGuardsFacet } from '@/extensions/core'
import { pasteMultilineText } from '@/paste/operations'
import { structuralEditPolicyForBlock } from '@/data/structuralEditPolicy'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { getVimNormalModeActions, jumpVisibleBlocks } from '@/plugins/vim-normal-mode/actions'
import { extendSelectionDown } from '@/shortcuts/blockActions'
import { getDefaultActions } from '@/shortcuts/defaultShortcuts'
import {
  ActionContextTypes, type ActionConfig, type ActionTrigger, type CodeMirrorEditModeDependencies,
} from '@/shortcuts/types'
import { extendSelection, getBlocksInRange, getLastVisibleDescendant, nextDrawnStep, nextVisibleBlock, previousDrawnStep } from '@/utils/selection'

const USER: User = {id: 'user-1', name: 'Alice'}
const WS = 'ws-nested-surface-walk'
const DISPLAY: PropertyDisplayScopeLevels = {childBacked: true, workspace: 'none', panel: 'inherit'}
const SURFACE: DrawnChild = {kind: 'nested-surface', renderScopeId: 'surface.test:grid'}
const MEMBERS_QUERY = 'test.members'
const PROJECTION_SCOPE = 'surface.test:projection'
const OUTLINE_SCOPE = 'outline:page'
const GRID_SCOPE = 'surface.test:live-grid'
const GRID: DrawnChild = {kind: 'nested-surface', renderScopeId: GRID_SCOPE, scopeRootId: 'grid', members: ['r2', 'r1']}

declare module '@/data/api' {
  interface QueryRegistry {
    [MEMBERS_QUERY]: typeof membersQuery
  }
}

const AT_SURFACE = '<surface>'

/** A fixed member list, `<surface>` standing for the nested surface. */
const membersQuery = defineQuery<{members: string[]}, DrawnChild[]>({
  name: MEMBERS_QUERY,
  argsSchema: z.object({members: z.array(z.string())}),
  resultSchema: {parse: input => input as DrawnChild[]},
  resolve: async ({members}) => members.map(member => {
    if (member === AT_SURFACE) return SURFACE
    if (member === '<grid>') return GRID
    if (member === '<projection>') return {
      kind: 'nested-surface', renderScopeId: PROJECTION_SCOPE, scopeRootId: 'projection', members: ['survivor', 'projected-child'],
    }
    return member
  }),
})

const DRAWN: Record<string, string[]> = {host: ['q', AT_SURFACE], bare: [AT_SURFACE], board: ['c1', AT_SURFACE, 'c2'], grid: ['<grid>', 'tail'], projection: ['<projection>', 'empty', 'survivor']}

let sharedDb: TestDb
let repo: Repo
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: USER}).repo
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    queriesFacet.of(membersQuery, {source: 'test'}),
    surfaceOwnerFacet.of(({renderScopeId}) => {
      if (renderScopeId === GRID_SCOPE) return {blockId: 'grid', surface: SURFACE_OF_PAGE()}
      if (renderScopeId === PROJECTION_SCOPE) return {blockId: 'projection', surface: SURFACE_OF_PAGE()}
      return null
    }, {source: 'test'}),
    childrenViewFacet.of(({parent}) => DRAWN[parent.id] !== undefined && {
      id: 'test.members',
      read: () => parent.repo.query[MEMBERS_QUERY]({members: DRAWN[parent.id]!}),
    }, {source: 'test'}),
  ]))
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'page'})
    await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0', content: ''})
    await tx.create({id: 'before', workspaceId: WS, parentId: 'page', orderKey: 'a0', content: 'before'})
    await tx.create({id: 'host', workspaceId: WS, parentId: 'page', orderKey: 'a1', content: 'host'})
    await tx.create({id: 'q', workspaceId: WS, parentId: 'host', orderKey: 'a0', content: 'q'})
    await tx.create({id: 'machinery', workspaceId: WS, parentId: 'host', orderKey: 'a1', content: 'machinery'})
    await tx.create({id: 'bare', workspaceId: WS, parentId: 'page', orderKey: 'a2', content: 'bare'})
    await tx.create({id: 'after', workspaceId: WS, parentId: 'page', orderKey: 'a3', content: 'after'})
    await tx.create({id: 'board', workspaceId: WS, parentId: 'page', orderKey: 'a4', content: 'board'})
    await tx.create({id: 'c1', workspaceId: WS, parentId: 'board', orderKey: 'a0', content: 'c1'})
    await tx.create({id: 'c2', workspaceId: WS, parentId: 'board', orderKey: 'a1', content: 'c2'})
    await tx.create({id: 'grid', workspaceId: WS, parentId: 'page', orderKey: 'a5', content: 'grid'})
    await tx.create({id: 'tail', workspaceId: WS, parentId: 'grid', orderKey: 'a0', content: ''})
    await tx.create({id: 'r1', workspaceId: WS, parentId: 'grid', orderKey: 'a1', content: 'first'})
    await tx.create({id: 'r2', workspaceId: WS, parentId: 'grid', orderKey: 'a2', content: 'second'})
    await tx.create({id: 'projection', workspaceId: WS, parentId: 'page', orderKey: 'a6', content: 'query'})
    await tx.create({id: 'empty', workspaceId: WS, parentId: 'projection', orderKey: 'a0', content: ''})
    await tx.create({id: 'projected-child', workspaceId: WS, parentId: 'empty', orderKey: 'a0', content: 'projected'})
    await tx.create({id: 'survivor', workspaceId: WS, parentId: 'projection', orderKey: 'a1', content: 'survivor'})
  }, {scope: ChangeScope.BlockDefault})
})

const SURFACE_OF_PAGE = () => outlineSurfaceOf({scopeRootId: 'page', propertyDisplay: DISPLAY, renderScopeId: OUTLINE_SCOPE})!

const editorAt = (content: string, cursor: number): EditorView => {
  const view = {
    dispatch: vi.fn(),
    moveToLineBoundary: (_selection: unknown, forward: boolean) => ({head: forward ? content.length : 0}),
    coordsAtPos: () => ({left: 0, right: 0, top: 0, bottom: 1}),
    state: {
      selection: {main: {empty: true, from: cursor, to: cursor, anchor: cursor, head: cursor}},
      doc: {length: content.length, toString: () => content, sliceString: (from: number, to = content.length) => content.slice(from, to)},
    },
  }
  return view as unknown as EditorView
}

const pressInEditor = async (actionId: string, blockId: string, cursor: 'start' | 'end', surface: SurfaceCarrier = SURFACE_OF_PAGE()) => {
  const action = getDefaultActions({repo}).find(
    (candidate): candidate is ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM> =>
      candidate.id === actionId && candidate.context === ActionContextTypes.EDIT_MODE_CM)!
  const content = (await repo.load(blockId))!.content
  await action.handler({
    block: repo.block(blockId),
    editorView: editorAt(content, cursor === 'start' ? 0 : content.length),
    uiStateBlock: repo.block('ui'),
    ...surface,
  } satisfies CodeMirrorEditModeDependencies, {preventDefault: vi.fn()} as unknown as ActionTrigger)
}

const contentOf = async (id: string) => (await repo.load(id))?.content

describe('a nested surface among drawn children', () => {
  it('the walk passes over it, never into the data children it stands for, and says so', async () => {
    expect((await nextVisibleBlock(repo.block('host'), SURFACE_OF_PAGE()))?.id).toBe('q')
    expect(await nextDrawnStep(repo.block('q'), SURFACE_OF_PAGE())).toMatchObject({block: {id: 'bare'}, crossed: true})
    expect(await nextDrawnStep(repo.block('before'), SURFACE_OF_PAGE())).toMatchObject({block: {id: 'host'}, crossed: false})
    expect(await nextDrawnStep(repo.block('c1'), SURFACE_OF_PAGE())).toMatchObject({block: {id: 'c2'}, crossed: true})
    expect(await previousDrawnStep(repo.block('c2'), SURFACE_OF_PAGE())).toMatchObject({block: {id: 'c1'}, crossed: true})
  })

  it('stays inside a zoomed root even when it has a data parent', async () => {
    const zoom = {...SURFACE_OF_PAGE(), scopeRootId: 'host'}
    expect((await previousDrawnStep(repo.block('host'), zoom)).block).toBeNull()
    expect((await nextDrawnStep(repo.block('q'), zoom)).block).toBeNull()
  })

  it('the descent into a parent whose children end in it steps back to the block drawn before it', async () => {
    expect((await getLastVisibleDescendant(repo.block('host'), SURFACE_OF_PAGE())).id).toBe('q')
    expect((await getLastVisibleDescendant(repo.block('bare'), SURFACE_OF_PAGE())).id).toBe('bare')
    expect(await previousDrawnStep(repo.block('after'), SURFACE_OF_PAGE())).toMatchObject({block: {id: 'bare'}, crossed: true})
    expect(await previousDrawnStep(repo.block('bare'), SURFACE_OF_PAGE())).toMatchObject({block: {id: 'q'}, crossed: true})
  })

  it('counts as children the parent shows', async () => {
    const carrier = {scopeRootId: 'page', propertyDisplay: DISPLAY}
    expect((await structuralEditPolicyForBlock(repo.block('bare'), carrier)).createBelowPlacement).toBe('child-first')
    expect((await structuralEditPolicyForBlock(repo.block('after'), carrier)).createBelowPlacement).toBe('sibling-below')
  })

  it('Backspace does not merge a block into the one drawn above a nested surface', async () => {
    await pressInEditor('delete_empty_block_cm', 'q', 'start')
    expect(await contentOf('host')).toBe('hostq')
    await pressInEditor('delete_empty_block_cm', 'after', 'start')
    expect(await contentOf('after')).toBe('after')
    expect(await contentOf('bare')).toBe('bare')
  })

  it('Delete at a block’s end does not pull up the block past a nested surface', async () => {
    await pressInEditor('merge_next_block_cm', 'bare', 'end')
    expect(await contentOf('after')).toBe('after')
    expect(await contentOf('bare')).toBe('bare')
    await pressInEditor('merge_next_block_cm', 'before', 'end')
    expect(await contentOf('before')).toBe('beforehost')
  })
})


describe('focus across a nested surface with drawn rows', () => {
  it.each(['move_right_from_cm_end', 'move_down_from_cm_end'])('%s enters the first drawn grid row', async actionId => {
    await pressInEditor(actionId, 'grid', 'end')
    expect(peekFocusedBlockLocation(repo.block('ui'))).toEqual({blockId: 'r2', renderScopeId: GRID_SCOPE})
    expect(repo.block('ui').get(editorSelection)).toMatchObject({blockId: 'r2'})
  })

  it.each(['move_left_from_cm_start', 'move_up_from_cm_start'])('%s returns from the first grid row to its host', async actionId => {
    const {surface} = await nextDrawnStep(repo.block('grid'), SURFACE_OF_PAGE())
    expect(surface.renderScopeId).toBe(GRID_SCOPE)
    await pressInEditor(actionId, 'r2', 'start', surface)
    expect(peekFocusedBlockLocation(repo.block('ui'))).toEqual({blockId: 'grid', renderScopeId: OUTLINE_SCOPE})
    expect(repo.block('ui').get(editorSelection)).toMatchObject({blockId: 'grid'})
  })

  it('empty Backspace deletes the row and edits the preceding grid row', async () => {
    await pressInEditor('delete_empty_block_cm', 'tail', 'start')
    expect(await contentOf('tail')).toBeUndefined()
    expect(peekFocusedBlockLocation(repo.block('ui'))).toEqual({blockId: 'r1', renderScopeId: GRID_SCOPE})
    expect(repo.block('ui').get(editorSelection)).toMatchObject({blockId: 'r1', start: 5})
  })

  it('empty Backspace skips a projected occurrence of a deleted descendant', async () => {
    expect(await previousDrawnStep(repo.block('empty'), SURFACE_OF_PAGE())).toMatchObject({
      block: {id: 'projected-child'}, surface: {renderScopeId: PROJECTION_SCOPE},
    })
    await pressInEditor('delete_empty_block_cm', 'empty', 'start')
    expect(await contentOf('empty')).toBeUndefined()
    expect(await contentOf('projected-child')).toBeUndefined()
    expect(peekFocusedBlockLocation(repo.block('ui'))).toEqual({blockId: 'survivor', renderScopeId: OUTLINE_SCOPE})
  })

  it('refuses a merge with a named row across the grid boundary', async () => {
    await pressInEditor('merge_next_block_cm', 'grid', 'end')
    expect(await contentOf('grid')).toBe('grid')
    expect(await contentOf('r2')).toBe('second')
  })

  it('a normal-mode jump continues counting in the destination scope', async () => {
    const jump = await jumpVisibleBlocks(repo.block('grid'), SURFACE_OF_PAGE(), 2, 'down')
    expect(jump).toMatchObject({block: {id: 'r1'}, surface: {renderScopeId: GRID_SCOPE, scopeRootId: 'grid'}})
  })

  it('normal movement enters and exits the grid in drawn order', async () => {
    const uiStateBlock = repo.block('ui')
    const moveDown = getVimNormalModeActions({repo}).find(action => action.id === 'move_down')!
    const trigger = {preventDefault: vi.fn()} as unknown as ActionTrigger
    await focusBlock(uiStateBlock, 'grid', {renderScopeId: OUTLINE_SCOPE})
    await moveDown.handler({block: repo.block('grid'), uiStateBlock, ...SURFACE_OF_PAGE()}, trigger)
    await vi.waitFor(() => expect(peekFocusedBlockLocation(uiStateBlock)).toEqual({blockId: 'r2', renderScopeId: GRID_SCOPE}))

    const first = await nextDrawnStep(repo.block('grid'), SURFACE_OF_PAGE())
    const last = await nextDrawnStep(first.block!, first.surface)
    await focusBlock(uiStateBlock, 'r1', {renderScopeId: GRID_SCOPE})
    await moveDown.handler({block: repo.block('r1'), uiStateBlock, ...last.surface}, trigger)
    await vi.waitFor(() => expect(peekFocusedBlockLocation(uiStateBlock)).toEqual({blockId: 'tail', renderScopeId: OUTLINE_SCOPE}))
  })
})

describe('ranges across drawn scopes', () => {
  it('selects siblings in drawn order and focuses the occurrence at the endpoint', async () => {
    const page = SURFACE_OF_PAGE()
    expect(await getBlocksInRange('r2', 'tail', {...page, renderScopeId: GRID_SCOPE}, repo, OUTLINE_SCOPE))
      .toEqual(['r2', 'r1', 'tail'])
    const ui = repo.block('ui')
    await focusBlock(ui, 'tail', {renderScopeId: OUTLINE_SCOPE})
    expect(await extendSelection('r1', ui, repo, {...page, renderScopeId: GRID_SCOPE})).toBe(true)
    expect(peekFocusedBlockLocation(ui)).toEqual({blockId: 'r1', renderScopeId: GRID_SCOPE})
  })

  it('Backspace on a projected member cannot consume it into a local sibling sharing the declared root', async () => {
    const page = SURFACE_OF_PAGE()
    const declared = {...page, scopeRootId: 'projection', renderScopeId: PROJECTION_SCOPE}
    expect(await previousDrawnStep(repo.block('projected-child'), declared)).toMatchObject({block: {id: 'survivor'}, crossed: true})
    expect(await nextDrawnStep(repo.block('survivor'), declared)).toMatchObject({block: {id: 'projected-child'}, crossed: true})
    await pressInEditor('delete_empty_block_cm', 'projected-child', 'start', declared)
    expect(await contentOf('projected-child')).toBe('projected')
    expect(await contentOf('survivor')).toBe('survivor')
  })

  it('Shift+Down advances past a projected result without collecting its source', async () => {
    const page = SURFACE_OF_PAGE()
    const ui = repo.block('ui')
    await focusBlock(ui, 'projection', {renderScopeId: OUTLINE_SCOPE})
    await extendSelectionDown(ui, repo, page)
    await extendSelectionDown(ui, repo, page)
    expect(peekFocusedBlockLocation(ui)).toEqual({blockId: 'survivor', renderScopeId: PROJECTION_SCOPE})
    await extendSelectionDown(ui, repo, page)
    expect(peekFocusedBlockLocation(ui)).toEqual({blockId: 'empty', renderScopeId: OUTLINE_SCOPE})
    expect(ui.peekProperty(selectionStateProp)?.selectedBlockIds).toEqual(['projection'])
  })

  it('passes over a foreign result and refuses it as an endpoint', async () => {
    const page = SURFACE_OF_PAGE()
    await repo.tx(tx => tx.move('projected-child', {parentId: null, orderKey: 'd0'}), {scope: ChangeScope.BlockDefault})
    expect(await getBlocksInRange('tail', 'empty', page, repo)).toEqual(['tail', 'projection'])
    expect(await getBlocksInRange('empty', 'tail', page, repo)).toEqual(['tail', 'projection'])
    const ui = repo.block('ui')
    await focusBlock(ui, 'projection', {renderScopeId: OUTLINE_SCOPE})
    const inner = {...page, renderScopeId: PROJECTION_SCOPE}
    expect(await extendSelection('projected-child', ui, repo, inner)).toBe(false)
    expect(peekFocusedBlockLocation(ui)).toEqual({blockId: 'projection', renderScopeId: OUTLINE_SCOPE})
  })
})

it('Backspace preserves an empty note and its child when the note leaves a result during confirmation', async () => {
  await repo.mutate.createChild({parentId: 'projected-child', id: 'blank-note'})
  await repo.mutate.createChild({parentId: 'blank-note', id: 'kept', content: 'Stored note'})
  let moved = false
  repo.setRuntimeContributions(blockDeletionGuardsFacet, 'test.move-note', [async () => {
    if (!moved) {
      moved = true
      await repo.mutate.move({id: 'blank-note', parentId: 'after', position: {kind: 'last'}})
    }
    return null
  }])
  await pressInEditor('delete_empty_block_cm', 'blank-note', 'start', {
    ...SURFACE_OF_PAGE(), renderScopeId: PROJECTION_SCOPE, scopeRootId: 'projected-child',
  })
  expect(await repo.load('blank-note')).toMatchObject({parentId: 'after'})
  expect(await repo.load('kept')).toMatchObject({parentId: 'blank-note', content: 'Stored note'})
})

it.each([
  ['indent', 'edit.cm.indent_block', 'r1', 'end'],
  ['create', 'split_block_cm', 'r1', 'end'],
  ['merge', 'delete_empty_block_cm', 'r1', 'start'],
  ['outdent', 'edit.cm.outdent_block', 'child', 'end'],
  ['paste', 'paste', 'r1', 'end'],
] as const)('%s inside a nested grid refuses when the whole grid has left its outer result', async (_, action, subject, cursor) => {
  await repo.mutate.createChild({parentId: 'r1', id: 'child', content: 'child'})
  await repo.mutate.move({id: 'grid', parentId: 'projected-child', position: {kind: 'last'}})
  const outer = {...SURFACE_OF_PAGE(), scopeRootId: 'projected-child', renderScopeId: PROJECTION_SCOPE}
  repo.setRuntimeContributions(surfaceOwnerFacet, 'test.inner', [({renderScopeId}) =>
    renderScopeId === GRID_SCOPE ? {blockId: 'grid', surface: outer} : null])
  const tx = repo.tx.bind(repo)
  vi.spyOn(repo, 'tx').mockImplementationOnce(async (fn, opts) => {
    await tx(t => t.move('grid', {parentId: 'after', orderKey: 'a0'}), {scope: ChangeScope.BlockDefault})
    return tx(fn, opts)
  })
  const scope = {...SURFACE_OF_PAGE(), renderScopeId: GRID_SCOPE, scopeRootId: 'grid'}
  const rows = () => sharedDb.db.getAll("SELECT id,parent_id,order_key,content,deleted FROM blocks WHERE id != 'grid' ORDER BY id")
  const before = await rows()
  if (action === 'paste') await pasteMultilineText('new', repo.block(subject), repo, scope)
  else await pressInEditor(action, subject, cursor, scope)
  expect(await rows()).toEqual(before)
  expect(await repo.load('grid')).toMatchObject({parentId: 'after'})
  expect(await repo.load('r1')).toMatchObject({parentId: 'grid'})
  expect(await repo.load('r2')).toMatchObject({parentId: 'grid'})
})
