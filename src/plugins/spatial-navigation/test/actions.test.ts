// @vitest-environment happy-dom

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, type User } from '@/data/api'
import { Repo } from '@/data/repo.js'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb.js'
import { createTestRepo } from '@/data/test/createTestRepo'
import {
  focusBlock,
  focusedBlockLocationProp,
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
    await tx.create({
      id: 'X',
      workspaceId: WS,
      parentId: null,
      orderKey: 'e0',
      content: 'backlink result',
    })
  }, {scope: ChangeScope.UiState})
}

interface NavInstance {blockId: string; renderScopeId: string; surface?: string}

const appendInstances = (panelEl: HTMLElement, instances: readonly NavInstance[]): void => {
  for (const {blockId, renderScopeId, surface} of instances) {
    const el = document.createElement('div')
    el.dataset.blockNavItem = 'true'
    el.dataset.blockId = blockId
    el.dataset.renderScopeId = renderScopeId
    if (surface) el.dataset.blockSurface = surface
    panelEl.appendChild(el)
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
      {blockId: 'A', renderScopeId: 'panel:A'},
      {blockId: 'X', renderScopeId: 'panel:backlink:X'},
    ])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:A'})
    // Seed an existing selection so this exercises the *extension* path (the
    // Roam-style first press selects only the current block — covered below).
    await panel.set(selectionStateProp, {selectedBlockIds: ['A'], anchorBlockId: 'A'})
    const fallback = vi.fn()
    const action = decorateAction({
      id: 'extend_selection_down',
      description: 'Extend selection down',
      context: ActionContextTypes.NORMAL_MODE,
      handler: async deps => {
        fallback()
        await extendSelectionDown(deps.uiStateBlock, env.repo, deps.scopeRootId)
      },
    })

    await action.handler({
      block: env.repo.block('A'),
      uiStateBlock: panel,
      renderScopeId: 'panel:A',
    } satisfies BlockShortcutDependencies, {} as ActionTrigger)

    expect(fallback).not.toHaveBeenCalled()
    expect(panel.peekProperty(selectionStateProp)).toEqual({
      selectedBlockIds: ['A', 'X'],
      anchorBlockId: 'A',
    })
    expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
      blockId: 'X',
      renderScopeId: 'panel:backlink:X',
    })
  })

  it('Roam-style first press selects only the focused block, not its neighbour', async () => {
    buildPanelDom([
      {blockId: 'A', renderScopeId: 'panel:A'},
      {blockId: 'X', renderScopeId: 'panel:backlink:X'},
    ])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:A'})
    // No prior selection — the first Shift+Down should select just A.
    const action = decorateAction({
      id: 'extend_selection_down',
      description: 'Extend selection down',
      context: ActionContextTypes.NORMAL_MODE,
      handler: async deps => {
        await extendSelectionDown(deps.uiStateBlock, env.repo, deps.scopeRootId)
      },
    })

    await action.handler({
      block: env.repo.block('A'),
      uiStateBlock: panel,
      renderScopeId: 'panel:A',
    } satisfies BlockShortcutDependencies, {} as ActionTrigger)

    expect(panel.peekProperty(selectionStateProp)?.selectedBlockIds).toEqual(['A'])
  })

  it('extends multi-select mode selection through DOM order without block dependencies', async () => {
    buildPanelDom([
      {blockId: 'A', renderScopeId: 'panel:A'},
      {blockId: 'X', renderScopeId: 'panel:backlink:X'},
    ])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:A'})
    await panel.set(selectionStateProp, {
      selectedBlockIds: ['A'],
      anchorBlockId: 'A',
    })
    const fallback = vi.fn()
    const action = decorateAction({
      id: 'multi_select.extend_selection_down',
      description: 'Extend selection down',
      context: ActionContextTypes.MULTI_SELECT_MODE,
      handler: async deps => {
        fallback()
        await extendSelectionDown(deps.uiStateBlock, env.repo, deps.scopeRootId)
      },
    })

    await action.handler({
      uiStateBlock: panel,
      selectedBlocks: [env.repo.block('A')],
      anchorBlock: env.repo.block('A'),
    } satisfies MultiSelectModeDependencies, {} as ActionTrigger)

    expect(fallback).not.toHaveBeenCalled()
    expect(panel.peekProperty(selectionStateProp)).toEqual({
      selectedBlockIds: ['A', 'X'],
      anchorBlockId: 'A',
    })
    expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
      blockId: 'X',
      renderScopeId: 'panel:backlink:X',
    })
  })

  // Note the explicit `surface`: every real row is tagged by the shell
  // decorator, and `moveVertical`'s boundary now branches on it. The selection
  // edge deliberately does NOT — declining here would re-derive the whole
  // range from the model and sweep in unmounted rows — so this has to be
  // pinned on the shape real rows actually have.
  it('treats the spatial edge as handled instead of falling through to hidden structural siblings', async () => {
    buildPanelDom([{blockId: 'A', renderScopeId: 'panel:A', surface: 'outline'}])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:A'})
    await panel.set(selectionStateProp, {
      selectedBlockIds: ['A'],
      anchorBlockId: 'A',
    })
    const fallback = vi.fn()
    const action = decorateAction({
      id: 'multi_select.extend_selection_down',
      description: 'Extend selection down',
      context: ActionContextTypes.MULTI_SELECT_MODE,
      handler: async deps => {
        fallback()
        await extendSelectionDown(deps.uiStateBlock, env.repo, deps.scopeRootId)
      },
    })

    await action.handler({
      uiStateBlock: panel,
      selectedBlocks: [env.repo.block('A')],
      anchorBlock: env.repo.block('A'),
    } satisfies MultiSelectModeDependencies, {} as ActionTrigger)

    expect(fallback).not.toHaveBeenCalled()
    expect(panel.peekProperty(selectionStateProp)).toEqual({
      selectedBlockIds: ['A'],
      anchorBlockId: 'A',
    })
  })
})

describe('spatial navigation shift-click selection', () => {
  const decoratePointerSelection = (action: ActionConfig): ActionConfig => {
    const decorator = getSpatialNavigationDispatchDecorators().find(candidate =>
      candidate.actionId === EXTEND_BLOCK_SELECTION_ACTION_ID &&
      candidate.context === ActionContextTypes.BLOCK_POINTER,
    )
    if (!decorator) throw new Error('Missing spatial shift-click decorator')
    return {
      ...action,
      handler: (deps, trigger, dispatch) =>
        decorator.wrap(deps, trigger, action.handler, dispatch),
    }
  }

  const blockNavItem = (blockId: string): HTMLElement => {
    const el = document.querySelector<HTMLElement>(`[data-block-id="${blockId}"]`)
    if (!el) throw new Error(`missing nav item ${blockId}`)
    return el
  }

  it('selects the visible DOM range from the anchor to the clicked block', async () => {
    // Anchor is the focused A; shift-clicking the backlink result X selects the
    // DOM-order range A..X — across the backlink, not the data tree.
    buildPanelDom([
      {blockId: 'A', renderScopeId: 'panel:A'},
      {blockId: 'X', renderScopeId: 'panel:backlink:X'},
    ])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:A'})
    const structural = vi.fn()
    const action = decoratePointerSelection({
      id: EXTEND_BLOCK_SELECTION_ACTION_ID,
      description: 'Extend block selection to the clicked block',
      context: ActionContextTypes.BLOCK_POINTER,
      handler: async () => { structural() },
    })

    await action.handler({
      block: env.repo.block('X'),
      uiStateBlock: panel,
      targetElement: blockNavItem('X'),
    } as BlockPointerDependencies, {} as ActionTrigger)

    expect(structural).not.toHaveBeenCalled()
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
    buildPanelDom([{blockId: 'A', renderScopeId: 'panel:A'}])
    const otherPanel = document.createElement('div')
    otherPanel.dataset.panelId = 'other-panel'
    const otherItem = document.createElement('div')
    otherItem.dataset.blockNavItem = 'true'
    otherItem.dataset.blockId = 'A'
    otherItem.dataset.renderScopeId = 'other:A'
    otherPanel.appendChild(otherItem)
    document.body.appendChild(otherPanel)

    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:A'})
    const structural = vi.fn()
    const action = decoratePointerSelection({
      id: EXTEND_BLOCK_SELECTION_ACTION_ID,
      description: 'Extend block selection to the clicked block',
      context: ActionContextTypes.BLOCK_POINTER,
      handler: async () => { structural() },
    })

    await action.handler({
      block: env.repo.block('A'),
      uiStateBlock: panel,
      targetElement: otherItem,
    } as BlockPointerDependencies, {} as ActionTrigger)

    expect(structural).toHaveBeenCalledTimes(1)
  })
})

describe('spatial navigation jump-to-edge actions', () => {
  it('jumps to the first block in visible DOM order', async () => {
    buildPanelDom([
      {blockId: 'A', renderScopeId: 'panel:A'},
      {blockId: 'B', renderScopeId: 'panel:B'},
      {blockId: 'X', renderScopeId: 'panel:backlink:X'},
    ])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'B', {renderScopeId: 'panel:B'})
    const fallback = vi.fn()
    const action = decorateAction({
      id: 'jump_to_first_visible_block',
      description: 'Jump to first visible block',
      context: ActionContextTypes.NORMAL_MODE,
      handler: async () => { fallback() },
    })

    await action.handler({
      block: env.repo.block('C'),
      uiStateBlock: panel,
      renderScopeId: 'panel:C',
      scopeRootId: 'top',
    } satisfies BlockShortcutDependencies, {} as ActionTrigger)

    expect(fallback).not.toHaveBeenCalled()
    expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
      blockId: 'A',
      renderScopeId: 'panel:A',
    })
  })

  it('jumps to the last block in visible DOM order — reaching a backlink the data tree would skip', async () => {
    buildPanelDom([
      {blockId: 'A', renderScopeId: 'panel:A'},
      {blockId: 'B', renderScopeId: 'panel:B'},
      {blockId: 'X', renderScopeId: 'panel:backlink:X'},
    ])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:A'})
    const fallback = vi.fn()
    const action = decorateAction({
      id: 'jump_to_last_visible_block',
      description: 'Jump to last visible block',
      context: ActionContextTypes.NORMAL_MODE,
      handler: async () => { fallback() },
    })

    await action.handler({
      block: env.repo.block('A'),
      uiStateBlock: panel,
      renderScopeId: 'panel:A',
      scopeRootId: 'top',
    } satisfies BlockShortcutDependencies, {} as ActionTrigger)

    expect(fallback).not.toHaveBeenCalled()
    expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
      blockId: 'X',
      renderScopeId: 'panel:backlink:X',
    })
  })

  it('falls through to the structural handler when the panel has no live DOM', async () => {
    // No buildPanelDom — panelById finds nothing, so the data-tree vim
    // handler must run instead of swallowing the keystroke.
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:A'})
    const fallback = vi.fn()
    const action = decorateAction({
      id: 'jump_to_last_visible_block',
      description: 'Jump to last visible block',
      context: ActionContextTypes.NORMAL_MODE,
      handler: async () => { fallback() },
    })

    await action.handler({
      block: env.repo.block('A'),
      uiStateBlock: panel,
      renderScopeId: 'panel:A',
      scopeRootId: 'top',
    } satisfies BlockShortcutDependencies, {} as ActionTrigger)

    expect(fallback).toHaveBeenCalledTimes(1)
  })
})

describe('spatial navigation vertical actions', () => {
  it('does not fall through when the focused rendered location is missing and has no safe recovery anchor', async () => {
    buildPanelDom([{blockId: 'A', renderScopeId: 'panel:A'}])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'X', {renderScopeId: 'panel:missing:X'})
    const fallback = vi.fn()
    const action = decorateAction({
      id: 'move_down',
      description: 'Move down',
      context: ActionContextTypes.NORMAL_MODE,
      handler: async () => {
        fallback()
      },
    })

    await action.handler({
      block: env.repo.block('X'),
      uiStateBlock: panel,
      renderScopeId: 'panel:missing:X',
    } satisfies BlockShortcutDependencies, {} as ActionTrigger)

    expect(fallback).not.toHaveBeenCalled()
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
      {blockId: 'A', renderScopeId: 'panel:A', surface: 'outline'},
      {blockId: 'B', renderScopeId: 'panel:B', surface: 'outline'},
    ])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'B', {renderScopeId: 'panel:B'})
    const fallback = vi.fn()
    const action = decorateAction({
      id: 'move_down',
      description: 'Move down',
      context: ActionContextTypes.NORMAL_MODE,
      handler: async () => { fallback() },
    })

    await action.handler({
      block: env.repo.block('B'),
      uiStateBlock: panel,
      renderScopeId: 'panel:B',
    } satisfies BlockShortcutDependencies, {} as ActionTrigger)

    expect(fallback).toHaveBeenCalledTimes(1)
  })

  // The other half of the same branch: on a non-outline surface the model
  // walk climbs a parent chain that lives on another page, so the boundary
  // must still be swallowed. (Reverting the surface check in `moveVertical`
  // flips exactly one of this pair, never both.)
  it('still swallows the boundary keystroke on a backlink surface', async () => {
    buildPanelDom([
      {blockId: 'A', renderScopeId: 'panel:A', surface: 'outline'},
      {blockId: 'X', renderScopeId: 'panel:backlink:X', surface: 'backlink'},
    ])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'X', {renderScopeId: 'panel:backlink:X'})
    const fallback = vi.fn()
    const action = decorateAction({
      id: 'move_down',
      description: 'Move down',
      context: ActionContextTypes.NORMAL_MODE,
      handler: async () => { fallback() },
    })

    await action.handler({
      block: env.repo.block('X'),
      uiStateBlock: panel,
      renderScopeId: 'panel:backlink:X',
    } satisfies BlockShortcutDependencies, {} as ActionTrigger)

    expect(fallback).not.toHaveBeenCalled()
  })

  // In a stacked column the DOM neighbour below the last MOUNTED row is the
  // next panel, so `verticalNeighbor` never returns null and the boundary
  // fall-through above can't fire. Without a model check, `j` leaps into the
  // panel below and silently skips the rest of this page.
  it('stays in the panel when the outline continues past the last mounted row', async () => {
    // 'A' is the last mounted row of the upper panel, but 'B' follows it in
    // the model (both children of 'top') and simply isn't mounted yet.
    buildStackedColumnDom(
      [{blockId: 'A', renderScopeId: 'panel:A', surface: 'outline'}],
      [{blockId: 'X', renderScopeId: 'below:X', surface: 'outline'}],
    )
    await seedPanelBelow(env.repo)
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:A'})
    const fallback = vi.fn()
    const action = decorateAction({
      id: 'move_down',
      description: 'Move down',
      context: ActionContextTypes.NORMAL_MODE,
      handler: async () => { fallback() },
    })

    await action.handler({
      block: env.repo.block('A'),
      uiStateBlock: panel,
      renderScopeId: 'panel:A',
      scopeRootId: 'top',
    } satisfies BlockShortcutDependencies, {} as ActionTrigger)

    expect(fallback).toHaveBeenCalledTimes(1)
    expect(env.repo.block('panel-below').peekProperty(focusedBlockLocationProp)).toBeUndefined()
  })

  // Mounting is sticky and an IntersectionObserver only reports per-frame
  // state, so a scrollbar drag leaves two mounted islands with a hole between
  // them. Here the DOM's next row is a real, mounted, same-panel outline row —
  // just the wrong one, with a deferred row in between.
  it('declines when the next mounted outline row is not the next model row', async () => {
    buildPanelDom([
      {blockId: 'A', renderScopeId: 'panel:A', surface: 'outline'},
      // 'B' sits between them in the model and simply isn't mounted.
      {blockId: 'C', renderScopeId: 'panel:C', surface: 'outline'},
    ])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:A'})
    const fallback = vi.fn()
    const action = decorateAction({
      id: 'move_down',
      description: 'Move down',
      context: ActionContextTypes.NORMAL_MODE,
      handler: async () => { fallback() },
    })

    await action.handler({
      block: env.repo.block('A'),
      uiStateBlock: panel,
      renderScopeId: 'panel:A',
      scopeRootId: 'top',
    } satisfies BlockShortcutDependencies, {} as ActionTrigger)

    expect(fallback).toHaveBeenCalledTimes(1)
    // Crucially NOT 'C' — that jump is the bug.
    expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
      blockId: 'A',
      renderScopeId: 'panel:A',
    })
  })

  // ...and the ordinary step is untouched: DOM and model agree, so spatial nav
  // handles it without deferring to the model handler.
  it('takes the mounted neighbour when it is the model row', async () => {
    buildPanelDom([
      {blockId: 'A', renderScopeId: 'panel:A', surface: 'outline'},
      {blockId: 'B', renderScopeId: 'panel:B', surface: 'outline'},
    ])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:A'})
    const fallback = vi.fn()
    const action = decorateAction({
      id: 'move_down',
      description: 'Move down',
      context: ActionContextTypes.NORMAL_MODE,
      handler: async () => { fallback() },
    })

    await action.handler({
      block: env.repo.block('A'),
      uiStateBlock: panel,
      renderScopeId: 'panel:A',
      scopeRootId: 'top',
    } satisfies BlockShortcutDependencies, {} as ActionTrigger)

    expect(fallback).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
        blockId: 'B',
        renderScopeId: 'panel:B',
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
      {blockId: 'A', renderScopeId: 'panel:A', surface: 'outline'},
      {blockId: 'X', renderScopeId: 'panel:backlink:X', surface: 'backlink'},
    ])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:A'})
    const fallback = vi.fn()
    const action = decorateAction({
      id: 'move_down',
      description: 'Move down',
      context: ActionContextTypes.NORMAL_MODE,
      handler: async () => { fallback() },
    })

    await action.handler({
      block: env.repo.block('A'),
      uiStateBlock: panel,
      renderScopeId: 'panel:A',
      scopeRootId: 'top',
    } satisfies BlockShortcutDependencies, {} as ActionTrigger)

    // 'B' follows 'A' in the model, so the keystroke belongs to the outline.
    expect(fallback).toHaveBeenCalledTimes(1)
    expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
      blockId: 'A',
      renderScopeId: 'panel:A',
    })
  })

  // ...and the feature this must not break: at the real end of the outline,
  // `j` still walks into the trailing surface.
  it('still steps into the trailing surface at the genuine end of the outline', async () => {
    buildPanelDom([
      {blockId: 'C', renderScopeId: 'panel:C', surface: 'outline'},
      {blockId: 'X', renderScopeId: 'panel:backlink:X', surface: 'backlink'},
    ])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'C', {renderScopeId: 'panel:C'})
    const fallback = vi.fn()
    const action = decorateAction({
      id: 'move_down',
      description: 'Move down',
      context: ActionContextTypes.NORMAL_MODE,
      handler: async () => { fallback() },
    })

    await action.handler({
      block: env.repo.block('C'),
      uiStateBlock: panel,
      renderScopeId: 'panel:C',
      scopeRootId: 'top',
    } satisfies BlockShortcutDependencies, {} as ActionTrigger)

    expect(fallback).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
        blockId: 'X',
        renderScopeId: 'panel:backlink:X',
      })
    })
  })

  it('still crosses into the stack sibling at the genuine end of the outline', async () => {
    // 'C' is the last child of 'top', so the model agrees the outline is done.
    buildStackedColumnDom(
      [{blockId: 'C', renderScopeId: 'panel:C', surface: 'outline'}],
      [{blockId: 'X', renderScopeId: 'below:X', surface: 'outline'}],
    )
    await seedPanelBelow(env.repo)
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'C', {renderScopeId: 'panel:C'})
    const fallback = vi.fn()
    const action = decorateAction({
      id: 'move_down',
      description: 'Move down',
      context: ActionContextTypes.NORMAL_MODE,
      handler: async () => { fallback() },
    })

    await action.handler({
      block: env.repo.block('C'),
      uiStateBlock: panel,
      renderScopeId: 'panel:C',
      scopeRootId: 'top',
    } satisfies BlockShortcutDependencies, {} as ActionTrigger)
    // (`panel-below` is seeded in both tests, so the negative assertion in the
    // sibling test can actually be false.)

    expect(fallback).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(env.repo.block('panel-below').peekProperty(focusedBlockLocationProp)).toEqual({
        blockId: 'X',
        renderScopeId: 'below:X',
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
      {blockId: 'A', renderScopeId: 'panel:A'},
      {blockId: 'cell', renderScopeId: 'panel:cell', surface: 'kanban-cell'},
      {blockId: 'B', renderScopeId: 'panel:B'},
    ])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:A'})
    const fallback = vi.fn()
    const action = decorateAction({
      id: 'move_down',
      description: 'Move down',
      context: ActionContextTypes.NORMAL_MODE,
      handler: async () => { fallback() },
    })

    await action.handler({
      block: env.repo.block('A'),
      uiStateBlock: panel,
      renderScopeId: 'panel:A',
    } satisfies BlockShortcutDependencies, {} as ActionTrigger)

    expect(fallback).not.toHaveBeenCalled()
    // Lands on B, skipping the kanban-cell-surfaced instance in between —
    // the plugin-contributed exclusion working through the real dispatch
    // path (moveVertical -> excludedSurfacesFor -> resolveSpatialNavExclusions),
    // not just a direct walker call. The same-panel step writes via a
    // fire-and-forget `void focusBlock(...)` (actions.ts), so poll rather
    // than assert immediately after `action.handler` resolves.
    await vi.waitFor(() => {
      expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({
        blockId: 'B',
        renderScopeId: 'panel:B',
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
