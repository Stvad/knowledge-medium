// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MouseEvent } from 'react'
import {
  blockOpenerAction,
  handleBlockLinkClick,
  navigate,
  navigateFromGlobalCommand,
  navigationVerb,
  resolveGlobalCommandTopLevelBlockId,
  type NavigateInput,
} from '@/utils/navigation'
import { panelHistory } from '@/utils/panelHistory'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import { getLayoutSessionBlock, getUIStateBlock } from '@/data/stateBlocks'
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
import { activePanelIdProp } from '@/data/properties'

const WS = 'ws-1'
const USER: User = {id: 'user-1', name: 'Alice'}

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  // Shared DB opened once per file (beforeAll), reset here per test.
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const repo = new Repo({
    db: sharedDb.db,
    cache: new BlockCache(),
    user: USER,
  })
  repo.setActiveWorkspaceId(WS)
  return {h, repo}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  __resetLayoutSessionIdForTesting()
  env = await setup()
})

afterEach(() => {
  vi.unstubAllGlobals()
  env.repo.stopSyncObserver()
})

const layoutSessionBlock = async () => {
  const uiState = await getUIStateBlock(env.repo, WS, USER, {})
  return getLayoutSessionBlock(uiState, getLayoutSessionId())
}

const currentPanelRows = async () => (await layoutSessionBlock()).children.load()

const currentPanelBlockIds = async () => panelBlockIds(await currentPanelRows())
const currentActivePanelId = async () => {
  const layoutSession = await layoutSessionBlock()
  await layoutSession.load()
  return layoutSession.peekProperty(activePanelIdProp)
}
const currentLayoutRows = async () => {
  const layoutSession = await layoutSessionBlock()
  return env.repo.query.subtree({id: layoutSession.id}).load()
}
const currentLayoutBlockIds = async () => {
  const layoutSession = await layoutSessionBlock()
  return layoutBlockIdsFromRows(layoutSession.id, await currentLayoutRows())
}

describe('navigate', () => {
  it("target 'main' creates the main panel when the layout is empty", async () => {
    navigate(env.repo, {blockId: 'b-main', target: 'main'})

    await vi.waitFor(async () => {
      expect(await currentPanelBlockIds()).toEqual(['b-main'])
    })
  })

  it("target 'panel' navigates that panel, activates it, and records local history", async () => {
    const layoutSession = await layoutSessionBlock()
    const panelId = await insertPanelRow(env.repo, layoutSession, 'b-prev')

    navigate(env.repo, {blockId: 'b-next', target: 'panel', panelId})

    await vi.waitFor(async () => {
      expect(await currentPanelBlockIds()).toEqual(['b-next'])
      expect(await currentActivePanelId()).toBe(panelId)
    })
    expect(panelHistory.getSnapshot(panelId).back.map(entry => entry.blockId)).toEqual(['b-prev'])
  })

  it("target 'main' updates the first panel from any context", async () => {
    const layoutSession = await layoutSessionBlock()
    await insertPanelRow(env.repo, layoutSession, 'b-main')
    await insertPanelRow(env.repo, layoutSession, 'b-side')

    navigate(env.repo, {blockId: 'b-new-main', target: 'main'})

    await vi.waitFor(async () => {
      expect(await currentPanelBlockIds()).toEqual(['b-new-main', 'b-side'])
    })
  })

  it("target 'active' navigates the stored active panel", async () => {
    const layoutSession = await layoutSessionBlock()
    await insertPanelRow(env.repo, layoutSession, 'b-main')
    const activePanel = await insertPanelRow(env.repo, layoutSession, 'b-side')

    navigate(env.repo, {blockId: 'b-active-next', target: 'active'})

    await vi.waitFor(async () => {
      expect(await currentPanelBlockIds()).toEqual(['b-main', 'b-active-next'])
      expect(await currentActivePanelId()).toBe(activePanel)
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
      const rows = await currentPanelRows()
      expect(await currentActivePanelId()).toBe(rows[1].id)
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

    navigate(env.repo, {blockId: 'b1', target: 'main'})

    expect(await currentPanelBlockIds()).toEqual([])
  })
})

describe('navigateFromGlobalCommand', () => {
  const stubViewport = (matches: boolean) => {
    vi.stubGlobal('window', {
      matchMedia: vi.fn().mockReturnValue({matches}),
    })
  }

  it('routes global commands to the main panel on desktop', async () => {
    stubViewport(false)
    const layoutSession = await layoutSessionBlock()
    await insertPanelRow(env.repo, layoutSession, 'b-main')
    await insertPanelRow(env.repo, layoutSession, 'b-side')

    navigateFromGlobalCommand(env.repo, {blockId: 'b-global'})

    await vi.waitFor(async () => {
      expect(await currentPanelBlockIds()).toEqual(['b-global', 'b-side'])
    })
    expect(await resolveGlobalCommandTopLevelBlockId(env.repo, WS)).toBe('b-global')
  })

  it('routes global commands to the active panel on mobile', async () => {
    stubViewport(true)
    const layoutSession = await layoutSessionBlock()
    await insertPanelRow(env.repo, layoutSession, 'b-main')
    await insertPanelRow(env.repo, layoutSession, 'b-side')

    navigateFromGlobalCommand(env.repo, {blockId: 'b-global'})

    await vi.waitFor(async () => {
      expect(await currentPanelBlockIds()).toEqual(['b-main', 'b-global'])
    })
    expect(await resolveGlobalCommandTopLevelBlockId(env.repo, WS)).toBe('b-global')
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

  it('plain primary click navigates the current panel with panelId', () => {
    const navigate = vi.fn<(i: NavigateInput) => void>()
    const e = makeEvent()
    handleBlockLinkClick(e, navigate, 'panel-a', ctx)
    expect(navigate).toHaveBeenCalledWith({...ctx, target: 'panel', panelId: 'panel-a'})
    expect(callsOf(e)).toEqual({stopProp: 1, preventDefault: 1})
  })

  it('plain primary click without panelId navigates the active panel', () => {
    const navigate = vi.fn<(i: NavigateInput) => void>()
    const e = makeEvent()
    handleBlockLinkClick(e, navigate, undefined, ctx)
    expect(navigate).toHaveBeenCalledWith({...ctx, target: 'active'})
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

describe('blockOpenerAction', () => {
  const ctx = {blockId: 'b-target', workspaceId: 'w-1'}

  it('routes plain follow-link click to the current panel', () => {
    expect(blockOpenerAction('default', 'follow-link', 'panel-a', ctx)).toEqual({
      kind: 'navigate',
      input: {...ctx, target: 'panel', panelId: 'panel-a'},
    })
  })

  it('routes plain navigator click through the global-command path', () => {
    expect(blockOpenerAction('default', 'navigator', 'panel-a', ctx)).toEqual({
      kind: 'global-command',
    })
  })

  it('routes shift-click to sidebar stack regardless of plainClick policy', () => {
    const expected = {kind: 'navigate' as const, input: {...ctx, target: 'sidebar-stack' as const, sourcePanelId: 'panel-a'}}
    expect(blockOpenerAction('sidebar-stack', 'follow-link', 'panel-a', ctx)).toEqual(expected)
    expect(blockOpenerAction('sidebar-stack', 'navigator', 'panel-a', ctx)).toEqual(expected)
  })

  it('routes shift+alt-click to new-panel regardless of plainClick policy', () => {
    const expected = {kind: 'navigate' as const, input: {...ctx, target: 'new-panel' as const, sourcePanelId: 'panel-a'}}
    expect(blockOpenerAction('new-panel', 'follow-link', 'panel-a', ctx)).toEqual(expected)
    expect(blockOpenerAction('new-panel', 'navigator', 'panel-a', ctx)).toEqual(expected)
  })

  it('routes alt-click to main regardless of plainClick policy', () => {
    const expected = {kind: 'navigate' as const, input: {...ctx, target: 'main' as const}}
    expect(blockOpenerAction('main', 'follow-link', 'panel-a', ctx)).toEqual(expected)
    expect(blockOpenerAction('main', 'navigator', 'panel-a', ctx)).toEqual(expected)
  })

  it('returns noop for native clicks (cmd/ctrl/middle) so the browser handles it', () => {
    expect(blockOpenerAction('native', 'follow-link', 'panel-a', ctx)).toEqual({kind: 'noop'})
    expect(blockOpenerAction('native', 'navigator', 'panel-a', ctx)).toEqual({kind: 'noop'})
  })
})

describe('navigationVerb (intent seam)', () => {
  it('navigate() resolves to the destination {panelId, blockId}', async () => {
    const result = await navigate(env.repo, {blockId: 'b1', target: 'main'})

    expect(result?.blockId).toBe('b1')
    expect(typeof result?.panelId).toBe('string')
    await vi.waitFor(async () => {
      expect(await currentPanelBlockIds()).toEqual(['b1'])
    })
  })

  it('an impl override replaces navigation wholesale', async () => {
    // The override returns a result without touching panels, so the default
    // navigation is fully replaced and no panel is created.
    env.repo.setRuntimeContributions(navigationVerb.implFacet, 'test-nav', [
      async () => ({panelId: 'custom', blockId: 'custom'}),
    ])

    const result = await navigate(env.repo, {blockId: 'b1', target: 'main'})

    expect(result).toEqual({panelId: 'custom', blockId: 'custom'})
    expect(await currentPanelBlockIds()).toEqual([])
  })

  it('a decorator vetoes by returning null without calling next', async () => {
    env.repo.setRuntimeContributions(navigationVerb.decoratorsFacet, 'test-nav', [
      () => async () => null,
    ])

    const result = await navigate(env.repo, {blockId: 'b1', target: 'main'})

    expect(result).toBeNull()
    expect(await currentPanelBlockIds()).toEqual([])
  })

  it('a decorator can rewrite the intent before the default applies it', async () => {
    env.repo.setRuntimeContributions(navigationVerb.decoratorsFacet, 'test-nav', [
      next => req => next({...req, input: {...req.input, blockId: 'rewritten'}}),
    ])

    await navigate(env.repo, {blockId: 'b1', target: 'main'})

    await vi.waitFor(async () => {
      expect(await currentPanelBlockIds()).toEqual(['rewritten'])
    })
  })

  it('before/after observers fire with the request and result', async () => {
    const calls: string[] = []
    env.repo.setRuntimeContributions(navigationVerb.beforeFacet, 'test-nav', [
      req => { calls.push(`before:${req.input.blockId}`) },
    ])
    env.repo.setRuntimeContributions(navigationVerb.afterFacet, 'test-nav', [
      (req, result) => { calls.push(`after:${req.input.blockId}:${result?.blockId}`) },
    ])

    await navigate(env.repo, {blockId: 'b1', target: 'main'})

    await vi.waitFor(() => {
      expect(calls).toContain('after:b1:b1')
    })
    expect(calls).toContain('before:b1')
  })

  it('a throwing override fails that navigation without re-running the default (no double-nav)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    env.repo.setRuntimeContributions(navigationVerb.implFacet, 'test-nav', [
      async () => {
        throw new Error('buggy nav plugin')
      },
    ])

    const result = await navigate(env.repo, {blockId: 'b1', target: 'main'})

    // Default policy is 'rethrow': navigate() catches and resolves to null, and
    // the default impl is NOT re-run — so no panel is created (no double-nav).
    expect(result).toBeNull()
    expect(await currentPanelBlockIds()).toEqual([])
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })
})
