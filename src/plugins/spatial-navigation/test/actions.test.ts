// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BlockCache } from '@/data/blockCache.js'
import { ChangeScope, type User } from '@/data/api'
import { Repo } from '@/data/repo.js'
import { createTestDb, type TestDb } from '@/data/test/createTestDb.js'
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
  type BlockShortcutDependencies,
  type MultiSelectModeDependencies,
} from '@/shortcuts/types.js'
import { extendSelectionDown } from '@/shortcuts/blockActions.js'
import { getSpatialNavigationActionDecorators } from '@/plugins/spatial-navigation/actions.js'

const WS = 'ws-1'
const USER: User = {id: 'user-1'}

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  const h = await createTestDb()
  const repo = new Repo({
    db: h.db,
    cache: new BlockCache(),
    user: USER,
    registerKernelProcessors: false,
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
    await tx.create({
      id: 'X',
      workspaceId: WS,
      parentId: null,
      orderKey: 'e0',
      content: 'backlink result',
    })
  }, {scope: ChangeScope.UiState})
}

const buildPanelDom = (instances: Array<{blockId: string; renderScopeId: string}>): void => {
  const panel = document.createElement('div')
  panel.dataset.panelId = 'panel'
  for (const {blockId, renderScopeId} of instances) {
    const el = document.createElement('div')
    el.dataset.blockNavItem = 'true'
    el.dataset.blockId = blockId
    el.dataset.renderScopeId = renderScopeId
    panel.appendChild(el)
  }
  document.body.appendChild(panel)
}

const decorateAction = <T extends typeof ActionContextTypes.NORMAL_MODE | typeof ActionContextTypes.MULTI_SELECT_MODE>(
  action: ActionConfig<T>,
): ActionConfig<T> => {
  const decorator = getSpatialNavigationActionDecorators().find(candidate =>
    candidate.actionId === action.id && candidate.context === action.context,
  )
  if (!decorator) throw new Error(`Missing spatial decorator for ${action.context}:${action.id}`)
  return decorator.decorate(action as ActionConfig) as ActionConfig<T>
}

let env: Harness

beforeEach(async () => {
  env = await setup()
  await seedPanelAndBlocks(env.repo)
})

afterEach(async () => {
  document.body.innerHTML = ''
  await env.h.cleanup()
})

describe('spatial navigation selection actions', () => {
  it('extends normal-mode selection through DOM order instead of structural order', async () => {
    buildPanelDom([
      {blockId: 'A', renderScopeId: 'panel:A'},
      {blockId: 'X', renderScopeId: 'panel:backlink:X'},
    ])
    const panel = env.repo.block('panel')
    await focusBlock(panel, 'A', {renderScopeId: 'panel:A'})
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

  it('treats the spatial edge as handled instead of falling through to hidden structural siblings', async () => {
    buildPanelDom([{blockId: 'A', renderScopeId: 'panel:A'}])
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
