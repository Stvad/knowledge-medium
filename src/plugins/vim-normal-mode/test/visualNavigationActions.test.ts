// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BlockCache } from '@/data/blockCache'
import { ChangeScope, type User } from '@/data/api'
import { Repo } from '@/data/repo'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import {
  focusedBlockIdProp,
  focusedVisualTargetKeyProp,
  topLevelBlockIdProp,
} from '@/data/properties'
import { getVimNormalModeActions } from '@/plugins/vim-normal-mode/actions.ts'
import {
  __resetVisualNavigationForTesting,
  registerVisualNavigationTarget,
} from '@/utils/visualNavigation.ts'
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
  repo: Repo,
  id: string,
): ActionConfig<typeof ActionContextTypes.NORMAL_MODE> => {
  const action = getVimNormalModeActions({repo}).find(
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

describe('vim normal mode visual navigation actions', () => {
  it('binds j and l to visual left and right movement', () => {
    expect(findNormalModeAction(env.repo, 'move_left').defaultBinding?.keys).toEqual(['left', 'j'])
    expect(findNormalModeAction(env.repo, 'move_right').defaultBinding?.keys).toEqual(['right', 'l'])
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

    const action = findNormalModeAction(env.repo, 'move_down')
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
})
