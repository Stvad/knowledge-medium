// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MouseEvent } from 'react'
import {
  handleBlockLinkClick,
  navigate,
  type NavigateInput,
} from '@/utils/navigation'
import { panelHistory } from '@/utils/panelHistory'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import { getLayoutSessionBlock, getUIStateBlock } from '@/data/globalState'
import {
  __resetLayoutSessionIdForTesting,
  getLayoutSessionId,
} from '@/utils/layoutSessionId'
import {
  insertPanelRow,
  layoutBlockIdsFromRows,
  layoutSlotsFromRows,
  panelBlockIds,
} from '@/utils/panelLayoutProjection'
import { type User } from '@/data/api'

const WS = 'ws-1'
const USER: User = {id: 'user-1', name: 'Alice'}

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

let env: Harness

beforeEach(async () => {
  __resetLayoutSessionIdForTesting()
  env = await setup()
})

afterEach(async () => {
  await env.h.cleanup()
})

const layoutSessionBlock = async () => {
  const uiState = await getUIStateBlock(env.repo, WS, USER, {})
  return getLayoutSessionBlock(uiState, getLayoutSessionId())
}

const currentPanelRows = async () => (await layoutSessionBlock()).children.load()

const currentPanelBlockIds = async () => panelBlockIds(await currentPanelRows())
const currentLayoutRows = async () => {
  const layoutSession = await layoutSessionBlock()
  return env.repo.query.subtree({id: layoutSession.id}).load()
}
const currentLayoutBlockIds = async () => {
  const layoutSession = await layoutSessionBlock()
  return layoutBlockIdsFromRows(layoutSession.id, await currentLayoutRows())
}

describe('navigate', () => {
  it("target 'focused' without panelId navigates the main panel", async () => {
    navigate(env.repo, {blockId: 'b-main', target: 'focused'})

    await vi.waitFor(async () => {
      expect(await currentPanelBlockIds()).toEqual(['b-main'])
    })
  })

  it("target 'focused' with panelId navigates that panel and records local history", async () => {
    const layoutSession = await layoutSessionBlock()
    const panelId = await insertPanelRow(env.repo, layoutSession, 'b-prev')

    navigate(env.repo, {blockId: 'b-next', target: 'focused', panelId})

    await vi.waitFor(async () => {
      expect(await currentPanelBlockIds()).toEqual(['b-next'])
    })
    expect(panelHistory.getSnapshot(panelId).back.map(entry => entry.blockId)).toEqual(['b-prev'])
  })

  it("target 'main' updates the first panel from any context", async () => {
    const layoutSession = await layoutSessionBlock()
    await insertPanelRow(env.repo, layoutSession, 'b-main')
    await insertPanelRow(env.repo, layoutSession, 'b-side')

    navigate(env.repo, {blockId: 'b-new-main', target: 'main', panelId: 'unused-side-panel'})

    await vi.waitFor(async () => {
      expect(await currentPanelBlockIds()).toEqual(['b-new-main', 'b-side'])
    })
  })

  it("target 'new-panel' inserts after the source panel", async () => {
    const layoutSession = await layoutSessionBlock()
    const firstPanelId = await insertPanelRow(env.repo, layoutSession, 'b-a')
    await insertPanelRow(env.repo, layoutSession, 'b-c')

    navigate(env.repo, {
      blockId: 'b-b',
      target: 'new-panel',
      sourcePanelId: firstPanelId,
    })

    await vi.waitFor(async () => {
      expect(await currentPanelBlockIds()).toEqual(['b-a', 'b-b', 'b-c'])
    })
  })

  it("target 'sidebar-stack' stacks above the panel to the right", async () => {
    const layoutSession = await layoutSessionBlock()
    const firstPanelId = await insertPanelRow(env.repo, layoutSession, 'b-a')
    const rightPanelId = await insertPanelRow(env.repo, layoutSession, 'b-b')
    await insertPanelRow(env.repo, layoutSession, 'b-c')

    navigate(env.repo, {
      blockId: 'b-x',
      target: 'sidebar-stack',
      sourcePanelId: firstPanelId,
    })

    await vi.waitFor(async () => {
      expect(await currentLayoutBlockIds()).toEqual(['b-a', 'b-x', 'b-b', 'b-c'])
    })
    expect(layoutSlotsFromRows(layoutSession.id, await currentLayoutRows())).toEqual([
      {kind: 'leaf', blockId: 'b-a'},
      {
        kind: 'stack',
        children: [
          {kind: 'leaf', blockId: 'b-x'},
          {kind: 'leaf', blockId: 'b-b'},
        ],
      },
      {kind: 'leaf', blockId: 'b-c'},
    ])
    const rightPanel = await env.repo.block(rightPanelId).load()
    expect(rightPanel?.parentId).not.toBe(layoutSession.id)
  })

  it('does nothing when no workspace can be resolved', async () => {
    env.repo.setActiveWorkspaceId(null)

    navigate(env.repo, {blockId: 'b1', target: 'focused'})

    expect(await currentPanelBlockIds()).toEqual([])
  })
})

describe('handleBlockLinkClick', () => {
  const ctx = {blockId: 'b-target', workspaceId: 'w-1'}

  const makeEvent = (overrides: Partial<MouseEvent> = {}): MouseEvent => {
    const calls = {stopProp: 0, preventDefault: 0}
    const e = {
      shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, button: 0,
      stopPropagation: () => { calls.stopProp += 1 },
      preventDefault: () => { calls.preventDefault += 1 },
      ...overrides,
    } as unknown as MouseEvent
    ;(e as unknown as {calls: typeof calls}).calls = calls
    return e
  }

  const callsOf = (e: MouseEvent) =>
    (e as unknown as {calls: {stopProp: number; preventDefault: number}}).calls

  it('shift-click navigates sidebar stack with sourcePanelId', () => {
    const navigate = vi.fn<(i: NavigateInput) => void>()
    const e = makeEvent({shiftKey: true})
    handleBlockLinkClick(e, navigate, 'panel-a', ctx)
    expect(navigate).toHaveBeenCalledWith({...ctx, target: 'sidebar-stack', sourcePanelId: 'panel-a'})
    expect(callsOf(e)).toEqual({stopProp: 1, preventDefault: 1})
  })

  it('shift+alt-click navigates new-panel with sourcePanelId', () => {
    const navigate = vi.fn<(i: NavigateInput) => void>()
    const e = makeEvent({shiftKey: true, altKey: true})
    handleBlockLinkClick(e, navigate, 'panel-a', ctx)
    expect(navigate).toHaveBeenCalledWith({...ctx, target: 'new-panel', sourcePanelId: 'panel-a'})
    expect(callsOf(e)).toEqual({stopProp: 1, preventDefault: 1})
  })

  it('alt-click navigates main panel', () => {
    const navigate = vi.fn<(i: NavigateInput) => void>()
    const e = makeEvent({altKey: true})
    handleBlockLinkClick(e, navigate, 'panel-a', ctx)
    expect(navigate).toHaveBeenCalledWith({...ctx, target: 'main'})
    expect(callsOf(e)).toEqual({stopProp: 1, preventDefault: 1})
  })

  it('plain primary click navigates focused with panelId', () => {
    const navigate = vi.fn<(i: NavigateInput) => void>()
    const e = makeEvent()
    handleBlockLinkClick(e, navigate, 'panel-a', ctx)
    expect(navigate).toHaveBeenCalledWith({...ctx, target: 'focused', panelId: 'panel-a'})
    expect(callsOf(e)).toEqual({stopProp: 1, preventDefault: 1})
  })

  it('plain primary click without panelId still navigates focused', () => {
    const navigate = vi.fn<(i: NavigateInput) => void>()
    const e = makeEvent()
    handleBlockLinkClick(e, navigate, undefined, ctx)
    expect(navigate).toHaveBeenCalledWith({...ctx, target: 'focused', panelId: undefined})
  })

  it.each([
    ['metaKey', {metaKey: true}],
    ['ctrlKey', {ctrlKey: true}],
    ['ctrl+shift', {ctrlKey: true, shiftKey: true}],
    ['middle-button', {button: 1}],
    ['right-button', {button: 2}],
  ])('falls through to href on %s (no navigate, no preventDefault)', (_name, override) => {
    const navigate = vi.fn<(i: NavigateInput) => void>()
    const e = makeEvent(override as Partial<MouseEvent>)
    handleBlockLinkClick(e, navigate, 'panel-a', ctx)
    expect(navigate).not.toHaveBeenCalled()
    expect(callsOf(e)).toEqual({stopProp: 1, preventDefault: 0})
  })

  it('shift+meta falls through to native behavior', () => {
    const navigate = vi.fn<(i: NavigateInput) => void>()
    const e = makeEvent({shiftKey: true, metaKey: true, altKey: true})
    handleBlockLinkClick(e, navigate, 'panel-a', ctx)
    expect(navigate).not.toHaveBeenCalled()
    expect(callsOf(e)).toEqual({stopProp: 1, preventDefault: 0})
  })
})
