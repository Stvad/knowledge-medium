// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import { BlockCache } from '@/data/blockCache'
import { ChangeScope, type User } from '@/data/api'
import { Repo } from '@/data/repo'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import {
  focusedBlockIdProp,
  focusedVisualTargetKeyProp,
  topLevelBlockIdProp,
} from '@/data/properties'
import { getVisualNavigationActions } from '@/plugins/visual-navigation/actions.ts'
import {
  __resetVisualNavigationForTesting,
  getActiveVisualNavigationTarget,
  registerVisualNavigationTarget,
  setActiveVisualNavigationTarget,
} from '@/plugins/visual-navigation/navigation.ts'
import {
  ActionContextTypes,
  type ActionConfig,
  type ActionTrigger,
  type BlockShortcutDependencies,
} from '@/shortcuts/types'

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

const findNormalModeAction = (
  id: string,
): ActionConfig<typeof ActionContextTypes.NORMAL_MODE> => {
  const action = getVisualNavigationActions().find(
    (candidate): candidate is ActionConfig<typeof ActionContextTypes.NORMAL_MODE> =>
      candidate.id === id && candidate.context === ActionContextTypes.NORMAL_MODE,
  )
  if (!action) throw new Error(`Action not found: ${id}`)
  return action
}

const makeElement = (rect: {top: number; left: number; width?: number; height?: number}) => {
  const width = rect.width ?? 100
  const height = rect.height ?? 24
  const element = document.createElement('div')
  Object.defineProperty(element, 'getBoundingClientRect', {
    value: () => ({
      top: rect.top,
      left: rect.left,
      right: rect.left + width,
      bottom: rect.top + height,
      width,
      height,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    }),
  })
  element.focus = vi.fn()
  document.body.appendChild(element)
  return element
}

let env: Harness

beforeEach(async () => {
  __resetVisualNavigationForTesting()
  document.body.innerHTML = ''
  env = await setup()
})

afterEach(async () => {
  __resetVisualNavigationForTesting()
  document.body.innerHTML = ''
  await env.h.cleanup()
})

describe('visual navigation actions', () => {
  it('binds j and l to visual left and right movement', () => {
    expect(findNormalModeAction('move_left').defaultBinding?.keys).toEqual(['left', 'j'])
    expect(findNormalModeAction('move_right').defaultBinding?.keys).toEqual(['right', 'l'])
  })

  it('moves down from the document body into a visually lower backlink occurrence', async () => {
    await env.repo.tx(async tx => {
      await tx.create({
        id: 'panel',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a0',
        properties: {
          [topLevelBlockIdProp.name]: topLevelBlockIdProp.codec.encode('root'),
          [focusedBlockIdProp.name]: focusedBlockIdProp.codec.encode('current'),
          [focusedVisualTargetKeyProp.name]: focusedVisualTargetKeyProp.codec.encode('current-target'),
        },
      })
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'b0', content: 'root'})
      await tx.create({id: 'current', workspaceId: WS, parentId: 'root', orderKey: 'a0', content: 'current'})
      await tx.create({id: 'backlink', workspaceId: WS, parentId: null, orderKey: 'c0', content: 'backlink'})
    }, {scope: ChangeScope.UiState})

    const uiStateBlock = env.repo.block('panel')
    const currentElement = makeElement({top: 0, left: 0})
    const backlinkElement = makeElement({top: 120, left: 0})
    const unregisterCurrent = registerVisualNavigationTarget({
      id: 'current-target',
      key: 'current-target',
      blockId: 'current',
      uiStateBlock,
      panelId: 'panel',
      surface: 'document',
      element: currentElement,
    })
    const unregisterBacklink = registerVisualNavigationTarget({
      id: 'backlink-target',
      key: 'backlink-target',
      blockId: 'backlink',
      uiStateBlock,
      panelId: 'panel',
      surface: 'backlink',
      element: backlinkElement,
    })

    const action = findNormalModeAction('move_down')
    await action.handler({
      block: env.repo.block('current'),
      uiStateBlock,
      visualTargetId: 'current-target',
    } satisfies BlockShortcutDependencies, {preventDefault: vi.fn()} as unknown as ActionTrigger)

    expect(uiStateBlock.peekProperty(focusedBlockIdProp)).toBe('backlink')
    expect(uiStateBlock.peekProperty(focusedVisualTargetKeyProp)).toBe('backlink-target')

    unregisterCurrent()
    unregisterBacklink()
  })

  it('stays on the current visual target at an edge instead of falling back to hidden tree focus', async () => {
    await env.repo.tx(async tx => {
      await tx.create({
        id: 'panel',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a0',
        properties: {
          [topLevelBlockIdProp.name]: topLevelBlockIdProp.codec.encode('root'),
          [focusedBlockIdProp.name]: focusedBlockIdProp.codec.encode('current'),
          [focusedVisualTargetKeyProp.name]: focusedVisualTargetKeyProp.codec.encode('current-target'),
        },
      })
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'b0', content: 'root'})
      await tx.create({id: 'current', workspaceId: WS, parentId: 'root', orderKey: 'a0', content: 'current'})
      await tx.create({id: 'hidden-tree-next', workspaceId: WS, parentId: 'root', orderKey: 'b0', content: 'hidden'})
    }, {scope: ChangeScope.UiState})

    const uiStateBlock = env.repo.block('panel')
    const currentElement = makeElement({top: 0, left: 0})
    const unregisterCurrent = registerVisualNavigationTarget({
      id: 'current-target',
      key: 'current-target',
      blockId: 'current',
      uiStateBlock,
      panelId: 'panel',
      surface: 'backlink',
      element: currentElement,
    })

    const action = findNormalModeAction('move_down')
    await action.handler({
      block: env.repo.block('current'),
      uiStateBlock,
      visualTargetId: 'current-target',
    } satisfies BlockShortcutDependencies, {preventDefault: vi.fn()} as unknown as ActionTrigger)

    expect(uiStateBlock.peekProperty(focusedBlockIdProp)).toBe('current')
    expect(uiStateBlock.peekProperty(focusedVisualTargetKeyProp)).toBe('current-target')

    unregisterCurrent()
  })

  it('recovers active visual focus to the nearest mounted target when the active occurrence unmounts', async () => {
    await env.repo.tx(async tx => {
      await tx.create({
        id: 'panel',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a0',
        properties: {
          [topLevelBlockIdProp.name]: topLevelBlockIdProp.codec.encode('root'),
          [focusedBlockIdProp.name]: focusedBlockIdProp.codec.encode('current'),
          [focusedVisualTargetKeyProp.name]: focusedVisualTargetKeyProp.codec.encode('current-target'),
        },
      })
      await tx.create({id: 'current', workspaceId: WS, parentId: null, orderKey: 'b0', content: 'current'})
      await tx.create({id: 'nearby', workspaceId: WS, parentId: null, orderKey: 'c0', content: 'nearby'})
    }, {scope: ChangeScope.UiState})

    const uiStateBlock = env.repo.block('panel')
    const currentElement = makeElement({top: 0, left: 0})
    const nearbyElement = makeElement({top: 32, left: 0})
    const unregisterCurrent = registerVisualNavigationTarget({
      id: 'current-target',
      key: 'current-target',
      blockId: 'current',
      uiStateBlock,
      panelId: 'panel',
      surface: 'document',
      element: currentElement,
    })
    const unregisterNearby = registerVisualNavigationTarget({
      id: 'nearby-target',
      key: 'nearby-target',
      blockId: 'nearby',
      uiStateBlock,
      panelId: 'panel',
      surface: 'document',
      element: nearbyElement,
    })
    setActiveVisualNavigationTarget('current-target')

    unregisterCurrent()

    expect(getActiveVisualNavigationTarget()?.id).toBe('nearby-target')
    await waitFor(() => {
      expect(uiStateBlock.peekProperty(focusedBlockIdProp)).toBe('nearby')
      expect(uiStateBlock.peekProperty(focusedVisualTargetKeyProp)).toBe('nearby-target')
    })

    unregisterNearby()
  })

  it('repairs focus when a focused backlink occurrence unmounts before its replacement registers', async () => {
    await env.repo.tx(async tx => {
      await tx.create({
        id: 'panel',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a0',
        properties: {
          [topLevelBlockIdProp.name]: topLevelBlockIdProp.codec.encode('root'),
          [focusedBlockIdProp.name]: focusedBlockIdProp.codec.encode('backlink'),
          [focusedVisualTargetKeyProp.name]: focusedVisualTargetKeyProp.codec.encode('old-backlink-target'),
        },
      })
      await tx.create({id: 'backlink', workspaceId: WS, parentId: null, orderKey: 'b0', content: 'backlink'})
    }, {scope: ChangeScope.UiState})

    const uiStateBlock = env.repo.block('panel')
    const oldElement = makeElement({top: 0, left: 0})
    const unregisterOld = registerVisualNavigationTarget({
      id: 'old-backlink-target',
      key: 'old-backlink-target',
      blockId: 'backlink',
      uiStateBlock,
      panelId: 'panel',
      surface: 'backlink',
      element: oldElement,
    })
    setActiveVisualNavigationTarget('old-backlink-target')

    unregisterOld()
    expect(getActiveVisualNavigationTarget()).toBeNull()

    const replacementElement = makeElement({top: 4, left: 0})
    const unregisterReplacement = registerVisualNavigationTarget({
      id: 'new-backlink-target',
      key: 'new-backlink-target',
      blockId: 'backlink',
      uiStateBlock,
      panelId: 'panel',
      surface: 'backlink',
      element: replacementElement,
    })

    await waitFor(() => {
      expect(getActiveVisualNavigationTarget()?.id).toBe('new-backlink-target')
      expect(uiStateBlock.peekProperty(focusedBlockIdProp)).toBe('backlink')
      expect(uiStateBlock.peekProperty(focusedVisualTargetKeyProp)).toBe('new-backlink-target')
    })

    unregisterReplacement()
  })
})
