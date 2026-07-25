// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyNavigationDecision,
  defaultNavigationIntent,
  goTo,
  mapNavigate,
  navigate,
  navigateFromGlobalCommand,
  navigationIntentVerb,
  navigationVerb,
  openBlockFromEvent,
  PASSTHROUGH,
  resolveGlobalCommandTarget,
  SUPPRESS,
  type NavigationDecision,
  type NavigationGesture,
} from '@/utils/navigation'
import { panelHistory } from '@/utils/panelHistory'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { getLayoutSessionBlock, getUIStateBlock } from '@/data/stateBlocks'
import { __resetLayoutSessionIdForTesting } from '@/utils/layoutSessionId'
import {
  insertPanelRow,
  layoutBlockIdsFromRows,
  layoutSlotsFromRows,
  panelBlockIds,
} from '@/utils/panelLayoutProjection'
import { type User } from '@/data/api'
import { activePanelIdProp, topLevelBlockIdProp } from '@/data/properties'

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
  const { repo } = createTestRepo({
    db: sharedDb.db,
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
})

const layoutSessionBlock = async () => {
  const uiState = await getUIStateBlock(env.repo, WS, USER, {})
  return getLayoutSessionBlock(uiState, env.repo.activeLayoutSessionId)
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

/** Stub `window.matchMedia` so the viewport rule resolves deterministically:
 *  `matches: true` → mobile (max-width query matches), `false` → desktop. */
const stubViewport = (matches: boolean) => {
  vi.stubGlobal('window', {
    matchMedia: vi.fn().mockReturnValue({matches}),
  })
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
          // The freshly stacked panel is activated by the navigation, so
          // the slot projection surfaces it as the active leaf.
          {kind: 'leaf', blockId: 'b-x', active: true},
          {kind: 'leaf', blockId: 'b-b'},
        ],
      },
      {kind: 'leaf', blockId: 'b-c'},
    ])
    const rightPanel = await env.repo.block(rightPanelId).load()
    expect(rightPanel?.parentId).not.toBe(layoutSession.id)
  })

  it('a navigation commits its active-panel write before resolving (no deferred write clobbers a later nav)', async () => {
    const layoutSession = await layoutSessionBlock()
    const mainPanel = await insertPanelRow(env.repo, layoutSession, 'b-main')

    // Fully-awaited, sequential navigations: navigate the existing main panel,
    // then open a new one. If the main nav defers its active-panel write past
    // its own resolution, that write lands after the new panel is created and
    // clobbers the active marker back to the main panel.
    await navigate(env.repo, {target: 'main', blockId: 'b-main-2'})
    const dest = await navigate(env.repo, {target: 'new-panel', blockId: 'b-new', sourcePanelId: mainPanel})

    expect(await currentActivePanelId()).toBe(dest?.panelId)
  })

  it("target 'panel' with an unknown panelId is a no-op (no ghost write)", async () => {
    const layoutSession = await layoutSessionBlock()
    await insertPanelRow(env.repo, layoutSession, 'b-real')

    const result = await navigate(env.repo, {blockId: 'b-x', target: 'panel', panelId: 'ghost-panel'})

    expect(result).toBeNull()
    // The live panel is untouched, and nothing was written to the ghost block.
    expect(await currentPanelBlockIds()).toEqual(['b-real'])
    await env.repo.load('ghost-panel')
    expect(env.repo.block('ghost-panel').peekProperty(topLevelBlockIdProp)).toBeUndefined()
  })

  it('does nothing when no workspace can be resolved', async () => {
    env.repo.setActiveWorkspaceId(null)

    navigate(env.repo, {blockId: 'b1', target: 'main'})

    expect(await currentPanelBlockIds()).toEqual([])
  })
})

describe('navigateFromGlobalCommand', () => {
  it('routes global commands to the main panel on desktop', async () => {
    stubViewport(false)
    const layoutSession = await layoutSessionBlock()
    await insertPanelRow(env.repo, layoutSession, 'b-main')
    await insertPanelRow(env.repo, layoutSession, 'b-side')

    navigateFromGlobalCommand(env.repo, {blockId: 'b-global'})

    await vi.waitFor(async () => {
      expect(await currentPanelBlockIds()).toEqual(['b-global', 'b-side'])
    })
    expect((await resolveGlobalCommandTarget(env.repo, WS))?.blockId).toBe('b-global')
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
    expect((await resolveGlobalCommandTarget(env.repo, WS))?.blockId).toBe('b-global')
  })
})

describe('defaultNavigationIntent (default policy)', () => {
  const NO_MODS = {shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, button: 0}
  const gesture = (overrides: Partial<NavigationGesture> = {}): NavigationGesture => ({
    role: 'follow-link',
    modifiers: NO_MODS,
    panelId: 'panel-a',
    blockId: 'b-target',
    workspaceId: 'w-1',
    viewport: 'desktop',
    ...overrides,
  })
  const base = {blockId: 'b-target', workspaceId: 'w-1'}

  it('plain follow-link click navigates the source panel, tagged origin', () => {
    expect(defaultNavigationIntent(gesture())).toEqual(goTo({
      ...base, target: 'panel', panelId: 'panel-a', origin: 'follow-link',
    }))
  })

  it('plain follow-link click without a panel navigates the active panel', () => {
    expect(defaultNavigationIntent(gesture({panelId: undefined}))).toEqual(goTo({
      ...base, target: 'active', origin: 'follow-link',
    }))
  })

  it('plain navigator click lands in the main panel on desktop', () => {
    expect(defaultNavigationIntent(gesture({role: 'navigator'}))).toEqual(goTo({
      ...base, target: 'main', origin: 'navigator',
    }))
  })

  it('plain navigator click lands in the active panel on mobile', () => {
    expect(defaultNavigationIntent(gesture({role: 'navigator', viewport: 'mobile'}))).toEqual(goTo({
      ...base, target: 'active', origin: 'navigator',
    }))
  })

  it('shift-click stacks in the sidebar regardless of role', () => {
    const expected = {...base, target: 'sidebar-stack' as const, sourcePanelId: 'panel-a'}
    expect(defaultNavigationIntent(gesture({modifiers: {...NO_MODS, shiftKey: true}})))
      .toEqual(goTo({...expected, origin: 'follow-link'}))
    expect(defaultNavigationIntent(gesture({role: 'navigator', modifiers: {...NO_MODS, shiftKey: true}})))
      .toEqual(goTo({...expected, origin: 'navigator'}))
  })

  it('shift+alt-click opens a new panel; alt-click opens the main panel', () => {
    expect(defaultNavigationIntent(gesture({modifiers: {...NO_MODS, shiftKey: true, altKey: true}})))
      .toEqual(goTo({...base, target: 'new-panel', sourcePanelId: 'panel-a', origin: 'follow-link'}))
    expect(defaultNavigationIntent(gesture({modifiers: {...NO_MODS, altKey: true}})))
      .toEqual(goTo({...base, target: 'main', origin: 'follow-link'}))
  })

  it('passes through native clicks (cmd/ctrl/middle/right) so the browser handles them', () => {
    expect(defaultNavigationIntent(gesture({modifiers: {...NO_MODS, metaKey: true}}))).toEqual(PASSTHROUGH)
    expect(defaultNavigationIntent(gesture({modifiers: {...NO_MODS, ctrlKey: true}}))).toEqual(PASSTHROUGH)
    expect(defaultNavigationIntent(gesture({modifiers: {...NO_MODS, button: 1}}))).toEqual(PASSTHROUGH)
    expect(defaultNavigationIntent(gesture({modifiers: {...NO_MODS, button: 2}}))).toEqual(PASSTHROUGH)
    // a modifier that would otherwise mean "main" still defers to the browser
    // when combined with cmd/ctrl
    expect(defaultNavigationIntent(gesture({modifiers: {...NO_MODS, altKey: true, metaKey: true}}))).toEqual(PASSTHROUGH)
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
      async () => ({panelId: 'custom', blockId: 'custom', workspaceId: 'custom'}),
    ])

    const result = await navigate(env.repo, {blockId: 'b1', target: 'main'})

    expect(result).toEqual({panelId: 'custom', blockId: 'custom', workspaceId: 'custom'})
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
      (req, outcome) => {
        const landed = outcome.ok ? outcome.result?.blockId : 'err'
        calls.push(`after:${req.input.blockId}:${landed}`)
      },
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

  it('a decorator can redirect a navigation by its origin tag', async () => {
    // Programmatic navigations carry an `origin`; a plugin redirects a specific
    // source (here 'zoom') without affecting other navigations — the execution-
    // layer counterpart to customizing gestures at the intent policy.
    const layoutSession = await layoutSessionBlock()
    await insertPanelRow(env.repo, layoutSession, 'b-main')
    const activePanel = await insertPanelRow(env.repo, layoutSession, 'b-side')
    env.repo.setRuntimeContributions(navigationVerb.decoratorsFacet, 'test-nav', [
      next => req =>
        req.input.origin === 'zoom'
          ? next({...req, input: {...req.input, target: 'active'}})
          : next(req),
    ])

    await navigate(env.repo, {blockId: 'b-zoomed', target: 'main', origin: 'zoom'})

    await vi.waitFor(async () => {
      // Redirected from main to the active (last) panel by the origin rule.
      expect(await currentPanelBlockIds()).toEqual(['b-main', 'b-zoomed'])
      expect(await currentActivePanelId()).toBe(activePanel)
    })
  })

  it('lands in the workspace captured at call time even if the active workspace changes mid-flight', async () => {
    // A before-observer flips the active workspace (simulating the user
    // switching workspaces while an async observer/confirmation runs). The
    // navigation must still land in the workspace that originated it (captured
    // up front in navigate()), not the newly-active one.
    env.repo.setRuntimeContributions(navigationVerb.beforeFacet, 'test-nav', [
      () => { env.repo.setActiveWorkspaceId('ws-other') },
    ])

    // No workspaceId on the input → captured from repo.activeWorkspaceId (WS).
    await navigate(env.repo, {blockId: 'b-captured', target: 'main'})

    // currentPanelBlockIds resolves WS's layout session — so this passing proves
    // the nav landed in WS, not the flipped 'ws-other'.
    await vi.waitFor(async () => {
      expect(await currentPanelBlockIds()).toEqual(['b-captured'])
    })
  })
})

describe('navigationIntentVerb (intent policy seam)', () => {
  it('resolves a navigator global command to the main panel on desktop by default', async () => {
    stubViewport(false)
    const layoutSession = await layoutSessionBlock()
    await insertPanelRow(env.repo, layoutSession, 'b-main')
    await insertPanelRow(env.repo, layoutSession, 'b-side')

    navigateFromGlobalCommand(env.repo, {blockId: 'b-global'})

    await vi.waitFor(async () => {
      expect(await currentPanelBlockIds()).toEqual(['b-global', 'b-side'])
    })
  })

  it('a policy decorator can override native passthrough (cmd-click → in-app navigation)', () => {
    // The default policy returns PASSTHROUGH for a cmd/ctrl/middle click (let the
    // browser open a new tab). Because the surface routes the policy's
    // `NavigationDecision` (no hardcoded native pre-check), a policy that maps
    // PASSTHROUGH to a `navigate` decision makes native passthrough overridable.
    env.repo.setRuntimeContributions(navigationIntentVerb.decoratorsFacet, 'test-policy', [
      next => gesture => {
        // `next` is typed MaybePromise (the verb API), but runSync resolves it
        // synchronously, so this decorator may treat it as sync.
        const decision = next(gesture) as NavigationDecision
        return decision.kind === 'passthrough'
          ? goTo({blockId: gesture.blockId, target: 'main'})
          : decision
      },
    ])
    const runtime = env.repo.facetRuntime!
    const cmdClick: NavigationGesture = {
      role: 'follow-link',
      modifiers: {shiftKey: false, altKey: false, metaKey: true, ctrlKey: false, button: 0},
      blockId: 'b-cmd',
      workspaceId: WS,
      viewport: 'desktop',
    }

    // Default policy → passthrough (native); the decorator overrides it to in-app.
    expect(defaultNavigationIntent(cmdClick)).toEqual(PASSTHROUGH)
    expect(navigationIntentVerb.runSync(runtime, cmdClick))
      .toEqual(goTo({blockId: 'b-cmd', target: 'main'}))
  })

  it('carries the gesture workspace into a navigate decision that omitted one (sync active switch)', async () => {
    stubViewport(false)
    // A policy impl that flips the active workspace synchronously during
    // resolution and returns a navigate WITHOUT a workspaceId. The navigation
    // must still land in the workspace the gesture captured (WS), not the
    // flipped one — `resolveNavigationIntent` carries it.
    env.repo.setRuntimeContributions(navigationIntentVerb.implFacet, 'test-policy', [
      gesture => {
        env.repo.setActiveWorkspaceId('ws-other')
        return goTo({blockId: gesture.blockId, target: 'main'})
      },
    ])

    await navigateFromGlobalCommand(env.repo, {blockId: 'b-ws'})

    // currentPanelBlockIds resolves WS's layout session — passing proves the nav
    // landed in WS despite the active flip and the omitted workspaceId.
    await vi.waitFor(async () => {
      expect(await currentPanelBlockIds()).toEqual(['b-ws'])
    })
  })

  it('the read probe honors a policy-retargeted workspace (read/write aligned)', async () => {
    stubViewport(false)
    // Seed a main panel in each workspace via navigate (creates each layout
    // session properly). WS shows b-ws1; ws-2 shows b-ws2.
    await navigate(env.repo, {target: 'main', blockId: 'b-ws1', workspaceId: WS})
    await navigate(env.repo, {target: 'main', blockId: 'b-ws2', workspaceId: 'ws-2'})

    // Policy retargets navigator gestures to ws-2; the read-side probe must
    // anchor on that retargeted workspace, matching where the write would land
    // (otherwise daily-note prev/next anchors on the wrong workspace).
    env.repo.setRuntimeContributions(navigationIntentVerb.decoratorsFacet, 'test-policy', [
      next => gesture =>
        mapNavigate(next(gesture) as NavigationDecision, input =>
          gesture.role === 'navigator' ? {...input, workspaceId: 'ws-2'} : input),
    ])

    // Reads from ws-2 (the retargeted workspace), not WS's b-ws1 — and returns
    // the resolved workspace so callers validate/create against ws-2, not WS.
    await vi.waitFor(async () => {
      expect(await resolveGlobalCommandTarget(env.repo, WS)).toEqual({blockId: 'b-ws2', workspaceId: 'ws-2'})
    })
  })

  it('a policy decorator redirects where global commands land (navigator → active on desktop)', async () => {
    // The original motivating example: a plugin redirects navigator commands to
    // the active panel even on desktop, by rewriting the policy's NavigateInput.
    stubViewport(false)
    env.repo.setRuntimeContributions(navigationIntentVerb.decoratorsFacet, 'test-policy', [
      next => gesture =>
        mapNavigate(next(gesture) as NavigationDecision, input =>
          gesture.role === 'navigator' && input.target === 'main'
            ? {...input, target: 'active'}
            : input),
    ])
    const layoutSession = await layoutSessionBlock()
    await insertPanelRow(env.repo, layoutSession, 'b-main')
    const activePanel = await insertPanelRow(env.repo, layoutSession, 'b-side')

    // The READ honors the same override: it anchors on the active panel (b-side),
    // not main (b-main) — so read-then-navigate flows stay consistent.
    expect((await resolveGlobalCommandTarget(env.repo, WS))?.blockId).toBe('b-side')

    navigateFromGlobalCommand(env.repo, {blockId: 'b-global'})

    await vi.waitFor(async () => {
      expect(await currentPanelBlockIds()).toEqual(['b-main', 'b-global'])
      expect(await currentActivePanelId()).toBe(activePanel)
    })
  })

  it('a policy impl can replace gesture resolution wholesale', async () => {
    stubViewport(false)
    // Force every navigator command into a fresh side panel, ignoring viewport.
    env.repo.setRuntimeContributions(navigationIntentVerb.implFacet, 'test-policy', [
      gesture => goTo({blockId: gesture.blockId, target: 'new-panel'}),
    ])
    const layoutSession = await layoutSessionBlock()
    await insertPanelRow(env.repo, layoutSession, 'b-main')

    navigateFromGlobalCommand(env.repo, {blockId: 'b-global'})

    await vi.waitFor(async () => {
      expect(await currentPanelBlockIds()).toEqual(['b-main', 'b-global'])
    })
  })

  it('a policy decorator can veto a gesture (SUPPRESS, no navigation)', async () => {
    stubViewport(false)
    env.repo.setRuntimeContributions(navigationIntentVerb.decoratorsFacet, 'test-policy', [
      () => () => SUPPRESS,
    ])

    const result = await navigateFromGlobalCommand(env.repo, {blockId: 'b-global'})

    expect(result).toBeNull()
    expect(await currentPanelBlockIds()).toEqual([])
  })

  it('falls back to the default policy when a plugin policy throws', async () => {
    stubViewport(false)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    env.repo.setRuntimeContributions(navigationIntentVerb.implFacet, 'test-policy', [
      () => { throw new Error('buggy policy') },
    ])

    // Pure verb on onError:'fallback' → default policy still resolves the
    // navigator command to the (empty-layout) main panel.
    navigateFromGlobalCommand(env.repo, {blockId: 'b-global'})

    await vi.waitFor(async () => {
      expect(await currentPanelBlockIds()).toEqual(['b-global'])
    })
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })
})

describe('applyNavigationDecision (DOM routing)', () => {
  // The single place that gates `preventDefault` for a clickable surface. A fake
  // event with spied stopPropagation/preventDefault lets the node-env suite cover
  // the native-vs-veto distinction that `useBlockOpener` delegates here.
  const fakeClick = () => ({stopPropagation: vi.fn(), preventDefault: vi.fn()})
  type ClickArg = Parameters<typeof applyNavigationDecision>[1]

  it('passthrough: declines the event so the browser follows the href', async () => {
    const e = fakeClick()
    applyNavigationDecision(env.repo, e as unknown as ClickArg, PASSTHROUGH)
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(e.stopPropagation).not.toHaveBeenCalled()
    expect(await currentPanelBlockIds()).toEqual([])
  })

  it('suppress (veto): owns the event and no-ops — href is suppressed, no navigation', async () => {
    const e = fakeClick()
    applyNavigationDecision(env.repo, e as unknown as ClickArg, SUPPRESS)
    expect(e.preventDefault).toHaveBeenCalled()
    expect(e.stopPropagation).toHaveBeenCalled()
    expect(await currentPanelBlockIds()).toEqual([])
  })

  it('navigate: owns the event and runs the in-app navigation', async () => {
    const e = fakeClick()
    applyNavigationDecision(env.repo, e as unknown as ClickArg, goTo({blockId: 'b-go', target: 'main', workspaceId: WS}))
    expect(e.preventDefault).toHaveBeenCalled()
    expect(e.stopPropagation).toHaveBeenCalled()
    await vi.waitFor(async () => {
      expect(await currentPanelBlockIds()).toEqual(['b-go'])
    })
  })
})

describe('openBlockFromEvent (useBlockOpener wiring)', () => {
  // Exercises the opener-click logic end to end (gesture build → resolve →
  // applyNavigationDecision) without a React render — the most user-facing path
  // the PR touches, otherwise only covered piecewise.
  const fakeMouseEvent = (
    mods: Partial<{shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean; button: number}> = {},
  ) => ({
    shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, button: 0,
    ...mods,
    stopPropagation: vi.fn(),
    preventDefault: vi.fn(),
  })
  type OpenerEvent = Parameters<typeof openBlockFromEvent>[1]

  it('plain follow-link click owns the event and navigates', async () => {
    const e = fakeMouseEvent()
    openBlockFromEvent(env.repo, e as unknown as OpenerEvent, {blockId: 'b-open', workspaceId: WS})
    expect(e.preventDefault).toHaveBeenCalled()
    expect(e.stopPropagation).toHaveBeenCalled()
    await vi.waitFor(async () => {
      expect(await currentPanelBlockIds()).toEqual(['b-open'])
    })
  })

  it('cmd-click is native passthrough — not prevented, no in-app navigation', async () => {
    const e = fakeMouseEvent({metaKey: true})
    openBlockFromEvent(env.repo, e as unknown as OpenerEvent, {blockId: 'b-cmd', workspaceId: WS})
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(e.stopPropagation).not.toHaveBeenCalled()
    expect(await currentPanelBlockIds()).toEqual([])
  })

  it('a vetoing policy suppresses: prevents the default but does not navigate', async () => {
    env.repo.setRuntimeContributions(navigationIntentVerb.decoratorsFacet, 'test-policy', [
      () => () => SUPPRESS,
    ])
    const e = fakeMouseEvent()
    openBlockFromEvent(env.repo, e as unknown as OpenerEvent, {blockId: 'b-veto', workspaceId: WS})
    expect(e.preventDefault).toHaveBeenCalled()
    expect(await currentPanelBlockIds()).toEqual([])
  })

  it('a policy can override native passthrough into an in-app navigation', async () => {
    env.repo.setRuntimeContributions(navigationIntentVerb.decoratorsFacet, 'test-policy', [
      next => gesture => {
        const decision = next(gesture) as NavigationDecision
        return decision.kind === 'passthrough'
          ? goTo({blockId: gesture.blockId, target: 'active'})
          : decision
      },
    ])
    const e = fakeMouseEvent({metaKey: true})
    openBlockFromEvent(env.repo, e as unknown as OpenerEvent, {blockId: 'b-cmd-nav', workspaceId: WS})
    expect(e.preventDefault).toHaveBeenCalled()
    await vi.waitFor(async () => {
      expect(await currentPanelBlockIds()).toEqual(['b-cmd-nav'])
    })
  })

  it('no-ops when no workspace can be resolved', () => {
    env.repo.setActiveWorkspaceId(null)
    const e = fakeMouseEvent()
    openBlockFromEvent(env.repo, e as unknown as OpenerEvent, {blockId: 'b-x'})
    expect(e.preventDefault).not.toHaveBeenCalled()
  })
})

describe('mapNavigate', () => {
  const nav = goTo({blockId: 'b', target: 'main', workspaceId: 'w'})
  // Simulate an untyped/dynamic mapper (transpiled without type-checking).
  type Mapper = Parameters<typeof mapNavigate>[1]

  it('tweaks the navigate input; passes passthrough/suppress through untouched', () => {
    expect(mapNavigate(nav, input => ({...input, target: 'active'})))
      .toEqual(goTo({blockId: 'b', target: 'active', workspaceId: 'w'}))
    expect(mapNavigate(PASSTHROUGH, () => ({blockId: 'x', target: 'main'}))).toBe(PASSTHROUGH)
    expect(mapNavigate(SUPPRESS, () => ({blockId: 'x', target: 'main'}))).toBe(SUPPRESS)
  })

  it('treats an explicit null as a veto (SUPPRESS) but leaves a malformed result invalid', () => {
    expect(mapNavigate(nav, () => null)).toBe(SUPPRESS)
    // An untyped mapper with a missing `return` → undefined must NOT silently
    // become a veto; it stays an invalid `navigate` so the verb can fall back.
    expect(mapNavigate(nav, (() => undefined) as unknown as Mapper))
      .toEqual({kind: 'navigate', input: undefined})
  })

  it('a decorator whose mapNavigate mapper returns undefined falls back to the default policy', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    env.repo.setRuntimeContributions(navigationIntentVerb.decoratorsFacet, 'test-policy', [
      next => gesture =>
        mapNavigate(next(gesture) as NavigationDecision, (() => undefined) as unknown as Mapper),
    ])
    const runtime = env.repo.facetRuntime!
    const gesture: NavigationGesture = {
      role: 'follow-link',
      modifiers: {shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, button: 0},
      panelId: 'panel-a',
      blockId: 'b-x',
      workspaceId: WS,
      viewport: 'desktop',
    }

    // The invalid mapper result fails validateResult → onError:'fallback' → the
    // default policy (navigate the source panel), NOT a silent SUPPRESS veto.
    expect(navigationIntentVerb.runSync(runtime, gesture)).toEqual(defaultNavigationIntent(gesture))
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })
})
