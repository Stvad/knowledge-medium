// @vitest-environment happy-dom

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { ChangeScope, type User } from '@/data/api'
import { Repo } from '@/data/repo.js'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb.js'
import { createTestRepo } from '@/data/test/createTestRepo'
import {
  focusBlock,
  focusedBlockLocationProp,
  isCollapsedProp,
  selectionStateProp,
  topLevelBlockIdProp,
} from '@/data/properties.js'
import {
  ActionContextTypes,
  type ActionConfig,
  type ActionTrigger,
  type BlockPointerDependencies,
  type BlockShortcutDependencies,
  type MultiSelectModeDependencies,
} from '@/shortcuts/types.js'
import { extendSelectionDown } from '@/shortcuts/blockActions.js'
import { EXTEND_BLOCK_SELECTION_ACTION_ID } from '@/extensions/blockSelectionAction.js'
import { getSpatialNavigationDispatchDecorators } from '@/plugins/spatial-navigation/actions.js'
import {
  resolveSpatialNavExclusions,
  spatialNavExclusionsFacet,
} from '@/plugins/spatial-navigation/exclusionsFacet.js'
import { DEFAULT_NON_NAVIGABLE_SURFACES } from '@/plugins/spatial-navigation/walker.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { kernelDataExtension } from '@/data/kernelDataExtension.js'

const WS = 'ws-1'
const USER: User = {id: 'user-1'}

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const { repo } = createTestRepo({
    db: h.db,
    user: USER,
  })
  repo.setActiveWorkspaceId(WS)
  return {h, repo}
}

const seedPanelAndBlocks = async (repo: Repo): Promise<void> => {
  await repo.tx(async tx => {
    await tx.create({
      id: 'panel',
      workspaceId: WS,
      parentId: null,
      orderKey: 'a0',
      properties: {[topLevelBlockIdProp.name]: topLevelBlockIdProp.codec.encode('top')},
    })
    await tx.create({
      id: 'top',
      workspaceId: WS,
      parentId: null,
      orderKey: 'b0',
      content: 'top',
    })
    await tx.create({
      id: 'A',
      workspaceId: WS,
      parentId: 'top',
      orderKey: 'c0',
      content: 'A',
    })
    await tx.create({
      id: 'B',
      workspaceId: WS,
      parentId: 'top',
      orderKey: 'd0',
      content: 'B',
    })
    // Third outline row, so a test can render a panel whose mounted rows skip
    // the middle one — the "two mounted islands" shape a scrollbar drag makes.
    await tx.create({
      id: 'C',
      workspaceId: WS,
      parentId: 'top',
      orderKey: 'd5',
      content: 'C',
    })
    // A child under 'B', so a test can put a row's own subtree and a nested
    // surface in the same shell — the model's next/previous row is then a
    // DESCENDANT of 'B', which is the case where "before or after this row's
    // children" decides the move.
    await tx.create({
      id: 'B1',
      workspaceId: WS,
      parentId: 'B',
      orderKey: 'd1',
      content: 'B1',
    })
    await tx.create({
      id: 'X',
      workspaceId: WS,
      parentId: null,
      orderKey: 'e0',
      content: 'backlink result',
    })
  }, {scope: ChangeScope.UiState})
}

interface NavInstance {
  blockId: string
  renderScopeId: string
  surface?: string
  /** Rows rendered INSIDE this row's shell, in order. The real shell wraps
   *  content, properties, children and footer alike, so both a nested surface's
   *  rows (an embed in the content or in a property value, a trailing backlink
   *  list) and this row's own children are DOM descendants of it — and WHERE
   *  each falls between them is the whole question `moveVertical` asks. */
  nested?: readonly NavChild[]
}

/** A row whose mount is still deferred: `LazyViewportMount` renders no nav item
 *  for it, only a placeholder holding its place in document order — labelled
 *  with the occurrence it is holding that place for. */
interface DeferredSlot {
  deferredBlockId: string
  /** The scope the row will have once it mounts. Omitted models a wrapper that
   *  mints its own scope inside itself (a backlink entry, a recents row), which
   *  deliberately leaves its slot anonymous. */
  deferredScopeId?: string
}

type NavChild = NavInstance | DeferredSlot

const appendInstances = (parentEl: HTMLElement, children: readonly NavChild[]): void => {
  for (const child of children) {
    if ('deferredBlockId' in child) {
      const slot = document.createElement('div')
      slot.dataset.lazyBlockId = child.deferredBlockId
      if (child.deferredScopeId !== undefined) {
        slot.dataset.lazyRenderScopeId = child.deferredScopeId
      }
      parentEl.appendChild(slot)
      continue
    }
    const {blockId, renderScopeId, surface, nested} = child
    const el = document.createElement('div')
    el.dataset.blockNavItem = 'true'
    el.dataset.blockId = blockId
    el.dataset.renderScopeId = renderScopeId
    if (surface) el.dataset.blockSurface = surface
    parentEl.appendChild(el)
    if (nested) appendInstances(el, nested)
  }
}

const buildPanelDom = (instances: NavInstance[]): void => {
  const panel = document.createElement('div')
  panel.dataset.panelId = 'panel'
  appendInstances(panel, instances)
  document.body.appendChild(panel)
}

/** Two panels stacked in one layout column, so `verticalNeighbor` can fall
 *  through from the end of the upper panel's MOUNTED rows into the lower one. */
const buildStackedColumnDom = (upper: NavInstance[], lower: NavInstance[]): void => {
  const column = document.createElement('div')
  column.dataset.layoutColumnId = 'col-1'
  for (const [panelId, instances] of [['panel', upper], ['panel-below', lower]] as const) {
    const panelEl = document.createElement('div')
    panelEl.dataset.panelId = panelId
    appendInstances(panelEl, instances)
    column.appendChild(panelEl)
  }
  document.body.appendChild(column)
}

/** The lower panel as a real UI-state block, so "focus did NOT move there"
 *  is a claim about behaviour rather than about a missing row. */
const seedPanelBelow = async (repo: Repo): Promise<void> => {
  await repo.tx(async tx => {
    await tx.create({
      id: 'panel-below',
      workspaceId: WS,
      parentId: null,
      orderKey: 'a1',
      properties: {[topLevelBlockIdProp.name]: topLevelBlockIdProp.codec.encode('X')},
    })
  }, {scope: ChangeScope.UiState})
}

// The spatial behaviour is now an action-dispatch decorator, so build a handler
// that runs the decorator's `wrap` with the base handler as `next` — exactly
// what `invokeAction` does at dispatch time.
const decorateAction = <T extends typeof ActionContextTypes.NORMAL_MODE | typeof ActionContextTypes.MULTI_SELECT_MODE>(
  action: ActionConfig<T>,
): ActionConfig<T> => {
  const decorator = getSpatialNavigationDispatchDecorators().find(candidate =>
    candidate.actionId === action.id && candidate.context === action.context,
  )
  if (!decorator) throw new Error(`Missing spatial decorator for ${action.context}:${action.id}`)
  return {
    ...action,
    handler: ((deps, trigger, dispatch) =>
      decorator.wrap(deps, trigger, action.handler as ActionConfig['handler'], dispatch)) as ActionConfig<T>['handler'],
  }
}

/** The navigation actions spatial nav decorates. The decorator registry matches
 *  on id + context only, so a description is presentational here and the id
 *  serves as one. */
type NavigationActionId =
  | 'move_down'
  | 'move_up'
  | 'jump_to_first_visible_block'
  | 'jump_to_last_visible_block'

/**
 * Press a navigation key through the real dispatch path — the spatial decorator
 * wrapping a base handler standing in for the model-walking vim one. The
 * returned spy answers the question every test below asks: did spatial nav
 * handle the keystroke itself, or decline and leave it to the model walk?
 *
 * `deps` is forwarded VERBATIM and nothing here may add to it. `scopeRootId` in
 * particular is optional, and several tests OMIT it deliberately — a surface
 * whose activation injected none — so the omission IS the scenario, and a
 * default here would quietly turn those tests into different ones that pass.
 */
const pressNavigationKey = async (
  id: NavigationActionId,
  deps: BlockShortcutDependencies,
): Promise<{modelWalk: Mock}> => {
  const modelWalk = vi.fn()
  const action = decorateAction({
    id,
    description: id,
    context: ActionContextTypes.NORMAL_MODE,
    handler: async () => { modelWalk() },
  })
  await action.handler(deps, {} as ActionTrigger)
  return {modelWalk}
}

/** Shift+Down, with the REAL structural `extendSelectionDown` as the base the
 *  decorator declines to — so a decline is observable as the data-tree range it
 *  produces, not merely as "the spy ran". Same verbatim-`deps` rule as above. */
const pressExtendSelectionDown = async (
  deps: BlockShortcutDependencies,
): Promise<{structuralExtend: Mock}> => {
  const structuralExtend = vi.fn()
  const action = decorateAction({
    id: 'extend_selection_down',
    description: 'Extend selection down',
    context: ActionContextTypes.NORMAL_MODE,
    handler: async baseDeps => {
      structuralExtend()
      await extendSelectionDown(baseDeps.uiStateBlock, env.repo, baseDeps.scopeRootId)
    },
  })
  await action.handler(deps, {} as ActionTrigger)
  return {structuralExtend}
}

/** The same key once multi-select mode owns it: a different action id and
 *  context, and deps that carry the selection rather than a focused block. */
const pressMultiSelectExtendDown = async (
  deps: MultiSelectModeDependencies,
): Promise<{structuralExtend: Mock}> => {
  const structuralExtend = vi.fn()
  const action = decorateAction({
    id: 'multi_select.extend_selection_down',
    description: 'Extend selection down',
    context: ActionContextTypes.MULTI_SELECT_MODE,
    handler: async baseDeps => {
      structuralExtend()
      await extendSelectionDown(baseDeps.uiStateBlock, env.repo, baseDeps.scopeRootId)
    },
  })
  await action.handler(deps, {} as ActionTrigger)
  return {structuralExtend}
}

/** Shift-click, through the pointer decorator and the structural selection base
 *  it declines to. */
const shiftClick = async (
  deps: BlockPointerDependencies,
): Promise<{structuralSelect: Mock}> => {
  const decorator = getSpatialNavigationDispatchDecorators().find(candidate =>
    candidate.actionId === EXTEND_BLOCK_SELECTION_ACTION_ID &&
    candidate.context === ActionContextTypes.BLOCK_POINTER,
  )
  if (!decorator) throw new Error('Missing spatial shift-click decorator')
  const structuralSelect = vi.fn()
  await decorator.wrap(deps, {} as ActionTrigger, async () => { structuralSelect() })
  return {structuralSelect}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  env = await setup()
  await seedPanelAndBlocks(env.repo)
})

afterEach(async () => {
  document.body.innerHTML = ''
})

describe('spatial navigation selection actions', () => {
  it('extends normal-mode selection through DOM order instead of structural order', async () => {
    buildPanelDom([
      {blockId: 'A', renderScopeId: 'panel:outline'},
      {blockId: 'X', renderScopeId: 'panel:backlink'},
    ])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:outline'})
    // Seed an existing selection so this exercises the *extension* path (the
    // Roam-style first press selects only the current block — covered below).
    await panel.set(selectionStateProp, {selectedBlockIds: ['A'], anchorBlockId: 'A'})

    const {structuralExtend} = await pressExtendSelectionDown({
      block: env.repo.block('A'),
      uiStateBlock: panel,
      renderScopeId: 'panel:outline',
    })

    expect(structuralExtend).not.toHaveBeenCalled()
    expect(panel.peekProperty(selectionStateProp)).toEqual({
      selectedBlockIds: ['A', 'X'],
      anchorBlockId: 'A',
    })
    expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
      blockId: 'X',
      renderScopeId: 'panel:backlink',
    })
  })

  it('Roam-style first press selects only the focused block, not its neighbour', async () => {
    buildPanelDom([
      {blockId: 'A', renderScopeId: 'panel:outline'},
      {blockId: 'X', renderScopeId: 'panel:backlink'},
    ])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:outline'})

    // No prior selection — the first Shift+Down should select just A.
    await pressExtendSelectionDown({
      block: env.repo.block('A'),
      uiStateBlock: panel,
      renderScopeId: 'panel:outline',
    })

    expect(panel.peekProperty(selectionStateProp)?.selectedBlockIds).toEqual(['A'])
  })

  it('extends multi-select mode selection through DOM order without block dependencies', async () => {
    buildPanelDom([
      {blockId: 'A', renderScopeId: 'panel:outline'},
      {blockId: 'X', renderScopeId: 'panel:backlink'},
    ])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:outline'})
    await panel.set(selectionStateProp, {
      selectedBlockIds: ['A'],
      anchorBlockId: 'A',
    })

    const {structuralExtend} = await pressMultiSelectExtendDown({
      uiStateBlock: panel,
      selectedBlocks: [env.repo.block('A')],
      anchorBlock: env.repo.block('A'),
    })

    expect(structuralExtend).not.toHaveBeenCalled()
    expect(panel.peekProperty(selectionStateProp)).toEqual({
      selectedBlockIds: ['A', 'X'],
      anchorBlockId: 'A',
    })
    expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
      blockId: 'X',
      renderScopeId: 'panel:backlink',
    })
  })

  // Note the explicit `surface`: every real row is tagged by the shell
  // decorator, and `moveVertical`'s boundary now branches on it. The selection
  // edge deliberately does NOT — declining here would re-derive the whole
  // range from the model and sweep in unmounted rows — so this has to be
  // pinned on the shape real rows actually have.
  it('treats the spatial edge as handled instead of falling through to hidden structural siblings', async () => {
    buildPanelDom([{blockId: 'A', renderScopeId: 'panel:outline', surface: 'outline'}])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:outline'})
    await panel.set(selectionStateProp, {
      selectedBlockIds: ['A'],
      anchorBlockId: 'A',
    })

    const {structuralExtend} = await pressMultiSelectExtendDown({
      uiStateBlock: panel,
      selectedBlocks: [env.repo.block('A')],
      anchorBlock: env.repo.block('A'),
    })

    expect(structuralExtend).not.toHaveBeenCalled()
    expect(panel.peekProperty(selectionStateProp)).toEqual({
      selectedBlockIds: ['A'],
      anchorBlockId: 'A',
    })
  })
})

describe('spatial navigation shift-click selection', () => {
  const blockNavItem = (blockId: string): HTMLElement => {
    const el = document.querySelector<HTMLElement>(`[data-block-id="${blockId}"]`)
    if (!el) throw new Error(`missing nav item ${blockId}`)
    return el
  }

  it('selects the visible DOM range from the anchor to the clicked block', async () => {
    // Anchor is the focused A; shift-clicking the backlink result X selects the
    // DOM-order range A..X — across the backlink, not the data tree.
    buildPanelDom([
      {blockId: 'A', renderScopeId: 'panel:outline'},
      {blockId: 'X', renderScopeId: 'panel:backlink'},
    ])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:outline'})

    const {structuralSelect} = await shiftClick({
      block: env.repo.block('X'),
      uiStateBlock: panel,
      targetElement: blockNavItem('X'),
    })

    expect(structuralSelect).not.toHaveBeenCalled()
    expect(panel.peekProperty(selectionStateProp)).toEqual({
      selectedBlockIds: ['A', 'X'],
      anchorBlockId: 'A',
    })
  })

  it('declines to the structural base when the clicked block is in another panel', async () => {
    // The load-bearing decline: extendSelectionToSpatialTarget reports a panel
    // mismatch as "handled" for the keyboard contract, so the transform gates on
    // the panel match and must fall through to the structural handler here —
    // otherwise a cross-panel shift-click would be silently swallowed.
    buildPanelDom([{blockId: 'A', renderScopeId: 'panel:outline'}])
    const otherPanel = document.createElement('div')
    otherPanel.dataset.panelId = 'other-panel'
    const otherItem = document.createElement('div')
    otherItem.dataset.blockNavItem = 'true'
    otherItem.dataset.blockId = 'A'
    otherItem.dataset.renderScopeId = 'other:A'
    otherPanel.appendChild(otherItem)
    document.body.appendChild(otherPanel)

    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:outline'})

    const {structuralSelect} = await shiftClick({
      block: env.repo.block('A'),
      uiStateBlock: panel,
      targetElement: otherItem,
    })

    expect(structuralSelect).toHaveBeenCalledTimes(1)
  })
})

describe('spatial navigation jump-to-edge actions', () => {
  it('jumps to the first block in visible DOM order', async () => {
    buildPanelDom([
      {blockId: 'A', renderScopeId: 'panel:outline'},
      {blockId: 'B', renderScopeId: 'panel:outline'},
      {blockId: 'X', renderScopeId: 'panel:backlink'},
    ])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'B', {renderScopeId: 'panel:outline'})

    const {modelWalk} = await pressNavigationKey('jump_to_first_visible_block', {
      block: env.repo.block('C'),
      uiStateBlock: panel,
      renderScopeId: 'panel:outline',
      scopeRootId: 'top',
    })

    expect(modelWalk).not.toHaveBeenCalled()
    expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
      blockId: 'A',
      renderScopeId: 'panel:outline',
    })
  })

  it('jumps to the last block in visible DOM order — reaching a backlink the data tree would skip', async () => {
    buildPanelDom([
      {blockId: 'A', renderScopeId: 'panel:outline'},
      {blockId: 'B', renderScopeId: 'panel:outline'},
      {blockId: 'X', renderScopeId: 'panel:backlink'},
    ])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:outline'})

    const {modelWalk} = await pressNavigationKey('jump_to_last_visible_block', {
      block: env.repo.block('A'),
      uiStateBlock: panel,
      renderScopeId: 'panel:outline',
      scopeRootId: 'top',
    })

    expect(modelWalk).not.toHaveBeenCalled()
    expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
      blockId: 'X',
      renderScopeId: 'panel:backlink',
    })
  })

  it('falls through to the structural handler when the panel has no live DOM', async () => {
    // No buildPanelDom — panelById finds nothing, so the data-tree vim
    // handler must run instead of swallowing the keystroke.
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:outline'})

    const {modelWalk} = await pressNavigationKey('jump_to_last_visible_block', {
      block: env.repo.block('A'),
      uiStateBlock: panel,
      renderScopeId: 'panel:outline',
      scopeRootId: 'top',
    })

    expect(modelWalk).toHaveBeenCalledTimes(1)
  })
})

describe('spatial navigation vertical actions', () => {
  it('does not fall through when the focused rendered location is missing and has no safe recovery anchor', async () => {
    buildPanelDom([{blockId: 'A', renderScopeId: 'panel:outline'}])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'X', {renderScopeId: 'panel:missing:X'})

    const {modelWalk} = await pressNavigationKey('move_down', {
      block: env.repo.block('X'),
      uiStateBlock: panel,
      renderScopeId: 'panel:missing:X',
    })

    expect(modelWalk).not.toHaveBeenCalled()
    expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
      blockId: 'X',
      renderScopeId: 'panel:missing:X',
    })
  })

  // Rows are mounted lazily, so "last instance in the panel DOM" means "last
  // row mounted so far", not "last row on the page". Swallowing the keystroke
  // there stranded the user: no focus write => no scroll => nothing new
  // mounts => `j` is dead for the rest of the page.
  it('falls through to the model walker at the end of the mounted outline rows', async () => {
    buildPanelDom([
      {blockId: 'A', renderScopeId: 'panel:outline', surface: 'outline'},
      {blockId: 'B', renderScopeId: 'panel:outline', surface: 'outline'},
    ])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'B', {renderScopeId: 'panel:outline'})

    const {modelWalk} = await pressNavigationKey('move_down', {
      block: env.repo.block('B'),
      uiStateBlock: panel,
      renderScopeId: 'panel:outline',
      scopeRootId: 'top',
    })

    expect(modelWalk).toHaveBeenCalledTimes(1)
  })

  // The other half of the same branch: on a non-outline surface the model
  // walk climbs a parent chain that lives on another page, so the boundary
  // must still be swallowed. (Reverting the surface check in `moveVertical`
  // flips exactly one of this pair, never both.)
  it('still swallows the boundary keystroke on a backlink surface', async () => {
    buildPanelDom([
      {blockId: 'A', renderScopeId: 'panel:outline', surface: 'outline'},
      {blockId: 'X', renderScopeId: 'panel:backlink', surface: 'backlink'},
    ])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'X', {renderScopeId: 'panel:backlink'})

    const {modelWalk} = await pressNavigationKey('move_down', {
      block: env.repo.block('X'),
      uiStateBlock: panel,
      renderScopeId: 'panel:backlink',
    })

    expect(modelWalk).not.toHaveBeenCalled()
  })

  // In a stacked column the DOM neighbour below the last MOUNTED row is the
  // next panel, so `verticalNeighbor` never returns null and the boundary
  // fall-through above can't fire. Without a model check, `j` leaps into the
  // panel below and silently skips the rest of this page.
  it('stays in the panel when the outline continues past the last mounted row', async () => {
    // 'A' is the last mounted row of the upper panel, but 'B' follows it in
    // the model (both children of 'top') and simply isn't mounted yet.
    buildStackedColumnDom(
      [{blockId: 'A', renderScopeId: 'panel:outline', surface: 'outline'}],
      [{blockId: 'X', renderScopeId: 'below:outline', surface: 'outline'}],
    )
    await seedPanelBelow(env.repo)
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:outline'})

    const {modelWalk} = await pressNavigationKey('move_down', {
      block: env.repo.block('A'),
      uiStateBlock: panel,
      renderScopeId: 'panel:outline',
      scopeRootId: 'top',
    })

    expect(modelWalk).toHaveBeenCalledTimes(1)
    expect(env.repo.block('panel-below').peekProperty(focusedBlockLocationProp)).toBeUndefined()
  })

  // The rule is about SCOPES, not surfaces. A backlink entry supplies its own
  // `scopeRootId` (its shown block), and rows inside it are lazily mounted
  // under the ordinary `block:<id>` key like any other row — so the same
  // hand-off works there. This used to be swallowed purely because the row
  // wasn't on the outline surface, which stranded `j` inside a tall entry.
  it('hands off inside a backlink entry when its own scope has more rows', async () => {
    buildPanelDom([
      // The entry's mounted rows have run out; 'B' is the next row of the
      // entry's own subtree and simply hasn't mounted.
      {blockId: 'A', renderScopeId: 'panel:backlink', surface: 'backlink'},
    ])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:backlink'})

    const {modelWalk} = await pressNavigationKey('move_down', {
      block: env.repo.block('A'),
      uiStateBlock: panel,
      renderScopeId: 'panel:backlink',
      // A backlink entry's scope root is the block it shows, not the page.
      scopeRootId: 'top',
    })

    expect(modelWalk).toHaveBeenCalledTimes(1)
  })

  // ...and the edge of a backlink entry is still an edge: nothing in that
  // scope's model, nothing in the DOM, so the keystroke stays handled.
  it('still swallows at the end of a backlink entry with nothing after it', async () => {
    buildPanelDom([
      {blockId: 'C', renderScopeId: 'panel:backlink', surface: 'backlink'},
    ])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'C', {renderScopeId: 'panel:backlink'})

    const {modelWalk} = await pressNavigationKey('move_down', {
      block: env.repo.block('C'),
      uiStateBlock: panel,
      renderScopeId: 'panel:backlink',
      scopeRootId: 'top',
    })

    expect(modelWalk).not.toHaveBeenCalled()
  })

  // Mounting is sticky and an IntersectionObserver only reports per-frame
  // state, so a scrollbar drag leaves two mounted islands with a hole between
  // them. Here the DOM's next row is a real, mounted, same-panel outline row —
  // just the wrong one, with a deferred row in between.
  it('declines when the next mounted outline row is not the next model row', async () => {
    buildPanelDom([{
      blockId: 'top',
      renderScopeId: 'panel:outline',
      surface: 'outline',
      nested: [
        {blockId: 'A', renderScopeId: 'panel:outline', surface: 'outline'},
        // 'B' sits between them in the model, still a placeholder.
        {deferredBlockId: 'B', deferredScopeId: 'panel:outline'},
        {blockId: 'C', renderScopeId: 'panel:outline', surface: 'outline'},
      ],
    }])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:outline'})

    const {modelWalk} = await pressNavigationKey('move_down', {
      block: env.repo.block('A'),
      uiStateBlock: panel,
      renderScopeId: 'panel:outline',
      scopeRootId: 'top',
    })

    expect(modelWalk).toHaveBeenCalledTimes(1)
    // Crucially NOT 'C' — that jump is the bug.
    expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
      blockId: 'A',
      renderScopeId: 'panel:outline',
    })
  })

  // One block renders under many scopes, so "same block id" is not agreement:
  // the mounted neighbour here IS the model's next row, but as a backlink
  // occurrence. Landing on that copy would strand `j` in the nested surface
  // instead of continuing down the outline.
  it('declines when the mounted copy of the next model row is on another surface', async () => {
    buildPanelDom([
      {blockId: 'A', renderScopeId: 'panel:outline', surface: 'outline'},
      // Same block the model wants next — but the backlink occurrence of it.
      {blockId: 'B', renderScopeId: 'panel:backlink', surface: 'backlink'},
    ])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:outline'})

    const {modelWalk} = await pressNavigationKey('move_down', {
      block: env.repo.block('A'),
      uiStateBlock: panel,
      renderScopeId: 'panel:outline',
      scopeRootId: 'top',
    })

    expect(modelWalk).toHaveBeenCalledTimes(1)
    expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
      blockId: 'A',
      renderScopeId: 'panel:outline',
    })
  })

  // A row's own nested surfaces — an embed in its content, an embed in a
  // property value — render rows of ANOTHER scope inside it, and no walk of
  // this scope can name them. They're navigable and on screen, so the DOM
  // neighbour disagreeing with the model is the normal case here, not evidence
  // that a row is missing.
  it('steps into a nested surface this row renders instead of jumping past it', async () => {
    buildPanelDom([
      {
        blockId: 'A',
        renderScopeId: 'panel:outline',
        surface: 'outline',
        nested: [{blockId: 'X', renderScopeId: 'embed:A:X', surface: 'embedded'}],
      },
      {blockId: 'B', renderScopeId: 'panel:outline', surface: 'outline'},
    ])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:outline'})

    const {modelWalk} = await pressNavigationKey('move_down', {
      block: env.repo.block('A'),
      uiStateBlock: panel,
      renderScopeId: 'panel:outline',
      scopeRootId: 'top',
    })

    expect(modelWalk).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
        blockId: 'X',
        renderScopeId: 'embed:A:X',
      })
    })
  })

  // ...and it must not depend on the model's row being mounted: an embed can be
  // a whole subtree tall, which puts the row after it far outside the overscan.
  // The deferred row still HOLDS ITS PLACE in the document, which is all the
  // decision needs.
  it('steps into a nested surface even when the model row after it has not mounted', async () => {
    buildPanelDom([{
      blockId: 'top',
      renderScopeId: 'panel:outline',
      surface: 'outline',
      nested: [
        {
          blockId: 'A',
          renderScopeId: 'panel:outline',
          surface: 'outline',
          nested: [{blockId: 'X', renderScopeId: 'embed:A:X', surface: 'embedded'}],
        },
        // 'B' follows 'A' in the model; its row is still a placeholder.
        {deferredBlockId: 'B', deferredScopeId: 'panel:outline'},
      ],
    }])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:outline'})

    const {modelWalk} = await pressNavigationKey('move_down', {
      block: env.repo.block('A'),
      uiStateBlock: panel,
      renderScopeId: 'panel:outline',
      scopeRootId: 'top',
    })

    expect(modelWalk).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
        blockId: 'X',
        renderScopeId: 'embed:A:X',
      })
    })
  })

  // The limit of that: a row's TRAILING sections (a footer backlink list) are
  // inside its shell too, but they render after its children. With the
  // children still deferred the nested rows are the only mounted thing left
  // inside the row — taking them would skip the whole subtree. Same containment,
  // opposite side of the children: only the POSITION tells the two apart.
  it('stays in this scope when the nested surface follows the row own deferred children', async () => {
    buildPanelDom([
      {
        blockId: 'top',
        renderScopeId: 'panel:outline',
        surface: 'outline',
        nested: [
          // top's children, none of them mounted yet...
          {deferredBlockId: 'A', deferredScopeId: 'panel:outline'},
          {deferredBlockId: 'B', deferredScopeId: 'panel:outline'},
          {deferredBlockId: 'C', deferredScopeId: 'panel:outline'},
          // ...and the trailing backlink list, which has.
          {blockId: 'X', renderScopeId: 'panel:backlink', surface: 'backlink'},
        ],
      },
    ])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'top', {renderScopeId: 'panel:outline'})

    const {modelWalk} = await pressNavigationKey('move_down', {
      block: env.repo.block('top'),
      uiStateBlock: panel,
      renderScopeId: 'panel:outline',
      scopeRootId: 'top',
    })

    expect(modelWalk).toHaveBeenCalledTimes(1)
    expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
      blockId: 'top',
      renderScopeId: 'panel:outline',
    })
  })

  // The row's own first child being the model's next row does NOT make its
  // content embed unreachable — the embed still renders ahead of the children.
  // (A tall embed is exactly what pushes that first child past the overscan, so
  // this is the reported bug, not a corner of it.)
  it('steps into a content embed when the row own first child is still deferred', async () => {
    buildPanelDom([{
      blockId: 'top',
      renderScopeId: 'panel:outline',
      surface: 'outline',
      nested: [{
        blockId: 'B',
        renderScopeId: 'panel:outline',
        surface: 'outline',
        nested: [
          // The embed in B's content, mounted...
          {blockId: 'X', renderScopeId: 'embed:B:X', surface: 'embedded'},
          // ...and B's own first child, which is what the model walk returns.
          {deferredBlockId: 'B1', deferredScopeId: 'panel:outline'},
        ],
      }],
    }])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'B', {renderScopeId: 'panel:outline'})

    const {modelWalk} = await pressNavigationKey('move_down', {
      block: env.repo.block('B'),
      uiStateBlock: panel,
      renderScopeId: 'panel:outline',
      scopeRootId: 'top',
    })

    expect(modelWalk).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
        blockId: 'X',
        renderScopeId: 'embed:B:X',
      })
    })
  })

  // The model moves first and React catches up. In that window the DOM still
  // holds a row the model no longer has anywhere — deleted here, but a reorder
  // leaves the same shape — and it sits exactly where the next row should be.
  it('declines a same-scope neighbour the model no longer has', async () => {
    buildPanelDom([{
      blockId: 'top',
      renderScopeId: 'panel:outline',
      surface: 'outline',
      nested: [
        {blockId: 'A', renderScopeId: 'panel:outline', surface: 'outline'},
        {blockId: 'B', renderScopeId: 'panel:outline', surface: 'outline'},
        {blockId: 'C', renderScopeId: 'panel:outline', surface: 'outline'},
      ],
    }])
    // 'B' is gone from the model; its row hasn't been removed yet.
    await env.repo.tx(async tx => { await tx.delete('B') }, {scope: ChangeScope.UiState})
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:outline'})

    const {modelWalk} = await pressNavigationKey('move_down', {
      block: env.repo.block('A'),
      uiStateBlock: panel,
      renderScopeId: 'panel:outline',
      scopeRootId: 'top',
    })

    // Not 'B': the model's next row is 'C', and focusing a row that is about to
    // unmount strands the cursor where nothing can walk from.
    expect(modelWalk).toHaveBeenCalledTimes(1)
    expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
      blockId: 'A',
      renderScopeId: 'panel:outline',
    })
  })

  // ...and the same staleness at a genuine model EDGE, where there is no model
  // row for a neighbour to be. The rendered order decides what comes after the
  // last row of a scope — but only for OTHER scopes; a row of this one is a
  // node the model has already dropped.
  it('declines a stale same-scope neighbour at the end of the scope', async () => {
    buildPanelDom([{
      blockId: 'top',
      renderScopeId: 'panel:outline',
      surface: 'outline',
      nested: [
        {blockId: 'A', renderScopeId: 'panel:outline', surface: 'outline'},
        {blockId: 'B', renderScopeId: 'panel:outline', surface: 'outline'},
        {blockId: 'C', renderScopeId: 'panel:outline', surface: 'outline'},
      ],
    }])
    // 'B' and 'C' are gone, so 'A' — which has no children — is the last visible
    // row and the walk genuinely ends at it. Their nodes are still here.
    await env.repo.tx(async tx => {
      await tx.delete('B')
      await tx.delete('C')
    }, {scope: ChangeScope.UiState})
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:outline'})

    const {modelWalk} = await pressNavigationKey('move_down', {
      block: env.repo.block('A'),
      uiStateBlock: panel,
      renderScopeId: 'panel:outline',
      scopeRootId: 'top',
    })

    expect(modelWalk).toHaveBeenCalledTimes(1)
    expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
      blockId: 'A',
      renderScopeId: 'panel:outline',
    })
  })

  // The same at the edge, for a row that only has a place RESERVED. Its slot
  // claims this scope, which the model has just said is finished.
  it('declines a stale same-scope reserved row at the end of the scope', async () => {
    buildPanelDom([{
      blockId: 'top',
      renderScopeId: 'panel:outline',
      surface: 'outline',
      nested: [
        {blockId: 'A', renderScopeId: 'panel:outline', surface: 'outline'},
        {deferredBlockId: 'C', deferredScopeId: 'panel:outline'},
      ],
    }])
    await env.repo.tx(async tx => {
      await tx.delete('B')
      await tx.delete('C')
    }, {scope: ChangeScope.UiState})
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:outline'})

    const {modelWalk} = await pressNavigationKey('move_down', {
      block: env.repo.block('A'),
      uiStateBlock: panel,
      renderScopeId: 'panel:outline',
      scopeRootId: 'top',
    })

    // The same-panel focus write is fire-and-forget, so a bare assertion here
    // would pass before a wrong one could land. Transactions commit in order:
    // once this one is through, anything queued ahead of it has landed too.
    await panel.set(selectionStateProp, {selectedBlockIds: ['A'], anchorBlockId: 'A'})

    // Not 'C': focusing it would also force-mount a row that is on its way out.
    expect(modelWalk).not.toHaveBeenCalled()
    expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
      blockId: 'A',
      renderScopeId: 'panel:outline',
    })
  })

  // A scope's own rows nest inside each other in the DOM, and a COLLAPSED row's
  // descendants can still be mounted for the commit or two before they go. They
  // are same-scope rows the model walk skips on purpose, and they sit inside the
  // row, so position alone reads them as "on the way".
  it('declines a same-scope descendant the model walk skipped over', async () => {
    buildPanelDom([{
      blockId: 'top',
      renderScopeId: 'panel:outline',
      surface: 'outline',
      nested: [
        {blockId: 'A', renderScopeId: 'panel:outline', surface: 'outline'},
        {
          blockId: 'B',
          renderScopeId: 'panel:outline',
          surface: 'outline',
          // B's own child, in B's own scope, still mounted inside it.
          nested: [{blockId: 'B1', renderScopeId: 'panel:outline', surface: 'outline'}],
        },
        {blockId: 'C', renderScopeId: 'panel:outline', surface: 'outline'},
      ],
    }])
    // ...but the model says B is collapsed, so its next row is 'C'.
    await env.repo.block('B').set(isCollapsedProp, true)
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'B', {renderScopeId: 'panel:outline'})

    const {modelWalk} = await pressNavigationKey('move_down', {
      block: env.repo.block('B'),
      uiStateBlock: panel,
      renderScopeId: 'panel:outline',
      scopeRootId: 'top',
    })

    // NOT 'B1': landing inside a collapsed subtree puts the cursor on a row the
    // user can't see, which unmounts a commit later.
    expect(modelWalk).toHaveBeenCalledTimes(1)
    expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
      blockId: 'B',
      renderScopeId: 'panel:outline',
    })
  })

  // The same hidden rows, reached from below. Walking up, the model stops AT a
  // collapsed row instead of descending into it, so the rows it skipped are
  // inside THAT row rather than inside this one — and `k` walked straight into
  // them, three keystrokes deep through a subtree the user can't see.
  it('declines a descendant of the model row the walk stopped at', async () => {
    buildPanelDom([{
      blockId: 'top',
      renderScopeId: 'panel:outline',
      surface: 'outline',
      nested: [
        {blockId: 'A', renderScopeId: 'panel:outline', surface: 'outline'},
        {
          blockId: 'B',
          renderScopeId: 'panel:outline',
          surface: 'outline',
          // B is collapsed, but its child hasn't unmounted yet.
          nested: [{blockId: 'B1', renderScopeId: 'panel:outline', surface: 'outline'}],
        },
        {blockId: 'C', renderScopeId: 'panel:outline', surface: 'outline'},
      ],
    }])
    await env.repo.block('B').set(isCollapsedProp, true)
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'C', {renderScopeId: 'panel:outline'})

    const {modelWalk} = await pressNavigationKey('move_up', {
      block: env.repo.block('C'),
      uiStateBlock: panel,
      renderScopeId: 'panel:outline',
      scopeRootId: 'top',
    })

    // The model's row is 'B' itself; the handler lands there, not on 'B1'.
    expect(modelWalk).toHaveBeenCalledTimes(1)
    expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
      blockId: 'C',
      renderScopeId: 'panel:outline',
    })
  })

  // Leaving a nested surface is the one step this scope's model can't judge:
  // it ends AT the edge, so nothing checks what the rendered neighbour skips.
  // A reserved row in between is part of the rendered order and gets the focus,
  // which also mounts it — declining could not, since the model handler is
  // bounded by the same exhausted scope and would swallow the keystroke.
  it('steps onto a reserved row when leaving a nested surface, not past it', async () => {
    buildPanelDom([{
      blockId: 'top',
      renderScopeId: 'panel:outline',
      surface: 'outline',
      nested: [
        {
          blockId: 'B',
          renderScopeId: 'panel:outline',
          surface: 'outline',
          nested: [
            // The embed's last (only) row — where focus is.
            {blockId: 'X', renderScopeId: 'embed:B:X', surface: 'embedded'},
            // B's own child, deferred, right after the embed.
            {deferredBlockId: 'B1', deferredScopeId: 'panel:outline'},
          ],
        },
        // What the DOM would otherwise hand back: a mounted row past B1.
        {blockId: 'A', renderScopeId: 'panel:backlink', surface: 'backlink'},
      ],
    }])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'X', {renderScopeId: 'embed:B:X'})

    const {modelWalk} = await pressNavigationKey('move_down', {
      block: env.repo.block('X'),
      uiStateBlock: panel,
      renderScopeId: 'embed:B:X',
      // An embed's scope root is the block it shows, so the walk ends here.
      scopeRootId: 'X',
    })

    expect(modelWalk).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
        blockId: 'B1',
        renderScopeId: 'panel:outline',
      })
    })
  })

  // ...and with nothing mounted after the embed at all, which is the shape a
  // tall embed makes: the walker returns no neighbour, so the keystroke would
  // otherwise be swallowed — no focus write, no scroll, nothing new mounts, and
  // `j` is dead for the rest of the page.
  it('steps onto a reserved row leaving a nested surface with no mounted neighbour', async () => {
    buildPanelDom([{
      blockId: 'top',
      renderScopeId: 'panel:outline',
      surface: 'outline',
      nested: [{
        blockId: 'B',
        renderScopeId: 'panel:outline',
        surface: 'outline',
        nested: [
          {blockId: 'X', renderScopeId: 'embed:B:X', surface: 'embedded'},
          {deferredBlockId: 'B1', deferredScopeId: 'panel:outline'},
        ],
      }],
      // Nothing mounted after the embed — B1's placeholder is the last thing.
    }])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'X', {renderScopeId: 'embed:B:X'})

    const {modelWalk} = await pressNavigationKey('move_down', {
      block: env.repo.block('X'),
      uiStateBlock: panel,
      renderScopeId: 'embed:B:X',
      scopeRootId: 'X',
    })

    expect(modelWalk).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
        blockId: 'B1',
        renderScopeId: 'panel:outline',
      })
    })
  })

  // A caller only reaches the edge case because the model found NO next row in
  // this scope — so this row has no visible children, and a slot of its own
  // scope still sitting inside it is a subtree that was just collapsed and
  // hasn't unmounted yet. Focusing it would put the cursor somewhere invisible.
  it('skips a reserved row that is this row own hidden child', async () => {
    buildPanelDom([{
      blockId: 'top',
      renderScopeId: 'panel:outline',
      surface: 'outline',
      nested: [
        {
          blockId: 'B',
          renderScopeId: 'panel:outline',
          surface: 'outline',
          nested: [{
            blockId: 'X',
            renderScopeId: 'embed:B:X',
            surface: 'embedded',
            // A child of the embed's own row, in the embed's scope, left over
            // from a collapse. The model says the embed scope is done.
            nested: [{deferredBlockId: 'A', deferredScopeId: 'embed:B:X'}],
          }],
        },
        {blockId: 'C', renderScopeId: 'panel:outline', surface: 'outline'},
      ],
    }])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'X', {renderScopeId: 'embed:B:X'})

    const {modelWalk} = await pressNavigationKey('move_down', {
      block: env.repo.block('X'),
      uiStateBlock: panel,
      renderScopeId: 'embed:B:X',
      scopeRootId: 'X',
    })

    expect(modelWalk).not.toHaveBeenCalled()
    // The mounted row after the embed, not the collapsed child inside it.
    await vi.waitFor(() => {
      expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
        blockId: 'C',
        renderScopeId: 'panel:outline',
      })
    })
  })

  // ...and a reserved row inside an excluded surface is not a step either: its
  // rows aren't navigable, so the NEXT keystroke would find no anchor at all.
  it('skips a reserved row inside an excluded surface', async () => {
    buildPanelDom([{
      blockId: 'top',
      renderScopeId: 'panel:outline',
      surface: 'outline',
      nested: [
        {
          blockId: 'B',
          renderScopeId: 'panel:outline',
          surface: 'outline',
          nested: [{blockId: 'X', renderScopeId: 'embed:B:X', surface: 'embedded'}],
        },
        {
          blockId: 'A',
          renderScopeId: 'panel:crumb',
          surface: 'breadcrumb',
          nested: [{deferredBlockId: 'B1', deferredScopeId: 'panel:crumb'}],
        },
        {blockId: 'C', renderScopeId: 'panel:outline', surface: 'outline'},
      ],
    }])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'X', {renderScopeId: 'embed:B:X'})

    const {modelWalk} = await pressNavigationKey('move_down', {
      block: env.repo.block('X'),
      uiStateBlock: panel,
      renderScopeId: 'embed:B:X',
      scopeRootId: 'X',
    })

    expect(modelWalk).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
        blockId: 'C',
        renderScopeId: 'panel:outline',
      })
    })
  })

  // An anonymous slot is one whose row will belong to a scope decided inside
  // the wrapper (a backlink entry, a recents row). Reading the surrounding DOM
  // for its scope would label it with the outline's — and then a slot sitting
  // AFTER the mounted neighbour makes "the neighbour comes first" vacuously
  // true, which is an accept, not a decline.
  it('ignores an anonymous slot when deciding where the model row sits', async () => {
    buildPanelDom([{
      blockId: 'top',
      renderScopeId: 'panel:outline',
      surface: 'outline',
      nested: [
        {blockId: 'A', renderScopeId: 'panel:outline', surface: 'outline'},
        {blockId: 'X', renderScopeId: 'panel:backlink', surface: 'backlink'},
        // A backlink entry's own deferred wrapper, which happens to be for the
        // block the outline walk wants next. It says nothing about where the
        // OUTLINE's copy of 'B' would render.
        {deferredBlockId: 'B'},
      ],
    }])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:outline'})

    const {modelWalk} = await pressNavigationKey('move_down', {
      block: env.repo.block('A'),
      uiStateBlock: panel,
      renderScopeId: 'panel:outline',
      scopeRootId: 'top',
    })

    expect(modelWalk).toHaveBeenCalledTimes(1)
    expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
      blockId: 'A',
      renderScopeId: 'panel:outline',
    })
  })

  // A slot answers only for the occurrence it belongs to. One block renders
  // under many scopes, so an embed of a subtree that contains the model's next
  // row reserves a slot for the SAME block id — one that says nothing about
  // where this scope's copy would go.
  it('ignores a deferred slot reserved by another scope copy of the model row', async () => {
    buildPanelDom([{
      blockId: 'top',
      renderScopeId: 'panel:outline',
      surface: 'outline',
      nested: [
        {
          blockId: 'A',
          renderScopeId: 'panel:outline',
          surface: 'outline',
          nested: [{
            blockId: 'Z',
            renderScopeId: 'embed:A:Z',
            surface: 'embedded',
            // The EMBED's copy of 'B' is deferred. The outline's own 'B' is not
            // rendered at all, so the outline still continues past what's here.
            nested: [{deferredBlockId: 'B', deferredScopeId: 'embed:A:Z'}],
          }],
        },
        {blockId: 'X', renderScopeId: 'panel:backlink', surface: 'backlink'},
      ],
    }])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:outline'})

    const {modelWalk} = await pressNavigationKey('move_down', {
      block: env.repo.block('A'),
      uiStateBlock: panel,
      renderScopeId: 'panel:outline',
      scopeRootId: 'top',
    })

    expect(modelWalk).toHaveBeenCalledTimes(1)
    expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
      blockId: 'A',
      renderScopeId: 'panel:outline',
    })
  })

  // Upward, the model's previous row is the previous sibling's last visible
  // DESCENDANT — so a mounted owner says nothing about it, and when that
  // descendant is deferred while the owner's trailing list is mounted, the
  // rows to walk back through are the trailing ones, below it.
  it('steps back into a trailing surface that follows the model row deferred slot', async () => {
    buildPanelDom([{
      blockId: 'top',
      renderScopeId: 'panel:outline',
      surface: 'outline',
      nested: [
        {
          blockId: 'B',
          renderScopeId: 'panel:outline',
          surface: 'outline',
          nested: [
            // B's last visible descendant — what `previousVisibleBlock` returns
            // for 'C' — is still a placeholder...
            {deferredBlockId: 'B1', deferredScopeId: 'panel:outline'},
            // ...while B's own trailing list is mounted, below it.
            {blockId: 'X', renderScopeId: 'backlink:B', surface: 'backlink'},
          ],
        },
        {blockId: 'C', renderScopeId: 'panel:outline', surface: 'outline'},
      ],
    }])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'C', {renderScopeId: 'panel:outline'})

    const {modelWalk} = await pressNavigationKey('move_up', {
      block: env.repo.block('C'),
      uiStateBlock: panel,
      renderScopeId: 'panel:outline',
      scopeRootId: 'top',
    })

    expect(modelWalk).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
        blockId: 'X',
        renderScopeId: 'backlink:B',
      })
    })
  })

  // Upward, the nested rows belong to the row we're walking BACK into, and `k`
  // from the row below lands on the last of them.
  it('steps back into the nested surface the previous row renders', async () => {
    buildPanelDom([
      {
        blockId: 'A',
        renderScopeId: 'panel:outline',
        surface: 'outline',
        nested: [{blockId: 'X', renderScopeId: 'embed:A:X', surface: 'embedded'}],
      },
      {blockId: 'B', renderScopeId: 'panel:outline', surface: 'outline'},
    ])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'B', {renderScopeId: 'panel:outline'})

    const {modelWalk} = await pressNavigationKey('move_up', {
      block: env.repo.block('B'),
      uiStateBlock: panel,
      renderScopeId: 'panel:outline',
      scopeRootId: 'top',
    })

    expect(modelWalk).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
        blockId: 'X',
        renderScopeId: 'embed:A:X',
      })
    })
  })

  // The rows under a block mount when its `childIds` handle resolves — which is
  // the very handle the model walk awaits. So the walk's own await is when the
  // model's row is most likely to appear, and a neighbour read before it can
  // already be the wrong row.
  it('re-reads the neighbour after the walk, so a row mounted during it is not skipped', async () => {
    buildPanelDom([
      {blockId: 'A', renderScopeId: 'panel:outline', surface: 'outline'},
      {blockId: 'X', renderScopeId: 'panel:backlink', surface: 'backlink'},
    ])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:outline'})

    // 'B' — the model's next row — mounts between 'A' and the backlink while the
    // walk is in flight. Driven off `load()` because that IS the wait: the walk
    // loads the row and its child list before it can answer.
    const mountModelRowDuringWalk = new Proxy(env.repo.block('A'), {
      get(target, prop) {
        if (prop === 'load') {
          return async () => {
            const panelEl = document.querySelector<HTMLElement>('[data-panel-id="panel"]')!
            const row = document.createElement('div')
            row.dataset.blockNavItem = 'true'
            row.dataset.blockId = 'B'
            row.dataset.renderScopeId = 'panel:outline'
            row.dataset.blockSurface = 'outline'
            panelEl.insertBefore(row, panelEl.children[1])
            return target.load()
          }
        }
        const value = Reflect.get(target, prop, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })

    const {modelWalk} = await pressNavigationKey('move_down', {
      block: mountModelRowDuringWalk,
      uiStateBlock: panel,
      renderScopeId: 'panel:outline',
      scopeRootId: 'top',
    })

    expect(modelWalk).not.toHaveBeenCalled()
    // NOT the backlink: it was the neighbour before 'B' mounted, and taking it
    // would jump the row that had just appeared in between.
    await vi.waitFor(() => {
      expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
        blockId: 'B',
        renderScopeId: 'panel:outline',
      })
    })
  })

  // The model walk can await an uncached `childIds`, and a click or a second
  // keystroke can land in that window. Everything after the await is computed
  // from a row that no longer holds focus, so the invocation must bow out.
  // (This pins the CONDITION — deps describing the old row while the panel's
  // focus has already moved — not the exact placement of the check.)
  it('bows out when focus moved while the model walk was in flight', async () => {
    buildPanelDom([
      {blockId: 'A', renderScopeId: 'panel:outline', surface: 'outline'},
      {blockId: 'B', renderScopeId: 'panel:outline', surface: 'outline'},
      {blockId: 'C', renderScopeId: 'panel:outline', surface: 'outline'},
    ])
    const panel = env.repo.block('panel')
    // Focus has already moved on — as it would have during the await.
    await focusBlock(panel, 'C', {renderScopeId: 'panel:outline'})

    // ...but this invocation still carries the row the keystroke started on.
    const {modelWalk} = await pressNavigationKey('move_down', {
      block: env.repo.block('A'),
      uiStateBlock: panel,
      renderScopeId: 'panel:outline',
      scopeRootId: 'top',
    })

    expect(modelWalk).not.toHaveBeenCalled()
    // The same-panel step writes fire-and-forget (`void focusBlock`), so a
    // bare assertion here would pass before a stale write could even land.
    // Fence on a write we CAN await: transactions commit in order, so once
    // this one is through, any focus write queued ahead of it has landed too.
    await panel.set(selectionStateProp, {selectedBlockIds: ['A'], anchorBlockId: 'A'})

    // Not 'B': that would be the superseded keystroke overwriting the newer one.
    expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
      blockId: 'C',
      renderScopeId: 'panel:outline',
    })
  })

  // ...and the ordinary step is untouched: DOM and model agree, so spatial nav
  // handles it without deferring to the model handler.
  it('takes the mounted neighbour when it is the model row', async () => {
    buildPanelDom([
      {blockId: 'A', renderScopeId: 'panel:outline', surface: 'outline'},
      {blockId: 'B', renderScopeId: 'panel:outline', surface: 'outline'},
    ])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:outline'})

    const {modelWalk} = await pressNavigationKey('move_down', {
      block: env.repo.block('A'),
      uiStateBlock: panel,
      renderScopeId: 'panel:outline',
      scopeRootId: 'top',
    })

    expect(modelWalk).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
        blockId: 'B',
        renderScopeId: 'panel:outline',
      })
    })
  })

  // The trailing-surface twin of the stacked-panel case: backlinks sit in the
  // same panel and carry their own overscan, so a mounted backlink entry can
  // follow the last mounted outline row while outline rows between them are
  // still deferred (their parent's `childIds` handle resolving, or a scroll
  // that left a hole). Accepting it would skip straight past the page.
  it('stays in the outline when the model continues past a mounted backlink', async () => {
    buildPanelDom([
      {blockId: 'A', renderScopeId: 'panel:outline', surface: 'outline'},
      {blockId: 'X', renderScopeId: 'panel:backlink', surface: 'backlink'},
    ])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:outline'})

    const {modelWalk} = await pressNavigationKey('move_down', {
      block: env.repo.block('A'),
      uiStateBlock: panel,
      renderScopeId: 'panel:outline',
      scopeRootId: 'top',
    })

    // 'B' follows 'A' in the model, so the keystroke belongs to the outline.
    expect(modelWalk).toHaveBeenCalledTimes(1)
    expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
      blockId: 'A',
      renderScopeId: 'panel:outline',
    })
  })

  // ...and the feature this must not break: at the real end of the outline,
  // `j` still walks into the trailing surface.
  it('still steps into the trailing surface at the genuine end of the outline', async () => {
    buildPanelDom([
      {blockId: 'C', renderScopeId: 'panel:outline', surface: 'outline'},
      {blockId: 'X', renderScopeId: 'panel:backlink', surface: 'backlink'},
    ])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'C', {renderScopeId: 'panel:outline'})

    const {modelWalk} = await pressNavigationKey('move_down', {
      block: env.repo.block('C'),
      uiStateBlock: panel,
      renderScopeId: 'panel:outline',
      scopeRootId: 'top',
    })

    expect(modelWalk).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
        blockId: 'X',
        renderScopeId: 'panel:backlink',
      })
    })
  })

  it('still crosses into the stack sibling at the genuine end of the outline', async () => {
    // 'C' is the last child of 'top', so the model agrees the outline is done.
    buildStackedColumnDom(
      [{blockId: 'C', renderScopeId: 'panel:outline', surface: 'outline'}],
      [{blockId: 'X', renderScopeId: 'below:outline', surface: 'outline'}],
    )
    await seedPanelBelow(env.repo)
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'C', {renderScopeId: 'panel:outline'})

    const {modelWalk} = await pressNavigationKey('move_down', {
      block: env.repo.block('C'),
      uiStateBlock: panel,
      renderScopeId: 'panel:outline',
      scopeRootId: 'top',
    })
    // (`panel-below` is seeded in both tests, so the negative assertion in the
    // sibling test can actually be false.)

    expect(modelWalk).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(env.repo.block('panel-below').peekProperty(focusedBlockLocationProp)).toEqual({
        blockId: 'X',
        renderScopeId: 'below:outline',
      })
    })
  })
})

// Integration coverage for the contributable exclusion seam
// (`exclusionsFacet.ts`): `exclusionsFacet.test.ts` proves the walker itself
// respects a contributed surface; these two tests prove it through the real
// consumer path instead — an actual repo/runtime carrying a plugin
// contribution, driven through the real `moveVertical` dispatch decorator —
// plus the inverse guard pinning the partial-runtime fallback.
describe('spatial navigation exclusion facet — real consumer path', () => {
  it('skips a plugin-contributed surface via moveVertical, the same way it skips breadcrumb', async () => {
    // Swap in a runtime carrying a plugin's own contribution alongside
    // core's — the same shape `createTestRepo({extensions})` builds — on the
    // already-seeded `env.repo` rather than a second `createTestRepo()` call:
    // a second Repo instance over the same shared db mints colliding tx
    // sequence numbers (`createTestRepo`'s own doc comment CAVEAT).
    env.repo.setFacetRuntime(resolveFacetRuntimeSync([
      kernelDataExtension,
      spatialNavExclusionsFacet.of('breadcrumb', {source: 'spatial-navigation'}),
      spatialNavExclusionsFacet.of('kanban-cell', {source: 'test-kanban-plugin'}),
    ]))

    buildPanelDom([
      {blockId: 'A', renderScopeId: 'panel:outline'},
      {blockId: 'cell', renderScopeId: 'panel:cell', surface: 'kanban-cell'},
      {blockId: 'B', renderScopeId: 'panel:outline'},
    ])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:outline'})

    const {modelWalk} = await pressNavigationKey('move_down', {
      block: env.repo.block('A'),
      uiStateBlock: panel,
      renderScopeId: 'panel:outline',
    })

    expect(modelWalk).not.toHaveBeenCalled()
    // Lands on B, skipping the kanban-cell-surfaced instance in between —
    // the plugin-contributed exclusion working through the real dispatch
    // path (moveVertical -> excludedSurfacesFor -> resolveSpatialNavExclusions),
    // not just a direct walker call. The same-panel step writes via a
    // fire-and-forget `void focusBlock(...)` (actions.ts), so poll rather
    // than assert immediately after `action.handler` resolves.
    await vi.waitFor(() => {
      expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
        blockId: 'B',
        renderScopeId: 'panel:outline',
      })
    })
  })

  it('resolves to the breadcrumb default on a bare kernel-only repo (no spatial-navigation contributions)', () => {
    const {repo} = createTestRepo({db: sharedDb.db, user: USER})
    expect(repo.facetRuntime).not.toBeNull()
    // Pins the fix for the MEDIUM finding: `Repo` installs a kernel-only
    // facet runtime by default (`installKernelRuntime` in repo.ts), which is
    // exactly what a bare `createTestRepo()` harness gets — non-null, but
    // without the spatial-navigation plugin's 'breadcrumb' contribution. That
    // must resolve to the pre-facet default, not silently "exclude nothing".
    expect(resolveSpatialNavExclusions(repo.facetRuntime)).toEqual(DEFAULT_NON_NAVIGABLE_SURFACES)
  })
})
