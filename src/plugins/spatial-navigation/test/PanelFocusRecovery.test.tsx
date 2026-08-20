// @vitest-environment happy-dom

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { ChangeScope, type User } from '@/data/api'
import type { Block } from '@/data/block'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import {
  focusedBlockLocationProp,
  peekFocusedBlockLocation,
} from '@/data/properties'
import { PanelFocusRecovery } from '../PanelFocusRecovery.tsx'
import { __resetSpatialNavigationForTesting, findRecoveryAnchor } from '../walker.ts'
import { resolveSpatialNavExclusions } from '../exclusionsFacet.ts'

const WS = 'ws-1'
const USER: User = {id: 'user-1'}
const PANEL_ID = 'panel'

// Comfortably past the component's RECOVERY_DEBOUNCE_MS (250) so a pending
// recovery would have fired if one were armed. The no-fire tests below pair
// it with a `repo.tx` spy: a recovery is `void focusBlock(...)`, an
// unawaited tx, so the focus VALUE still reads pre-recovery whatever the
// component did — asserting on it would pass with the watchdog deleted.
const DEBOUNCE_SETTLE_MS = 350

// A recovery costs the 250ms debounce plus a repo write, measured ~330-460ms
// in isolation; 6s is ~2x the ~6x full-gate stretch AGENTS.md budgets for.
// The last test awaits BOTH waits, so their sum must stay under the test
// timeout — otherwise the test timeout reports first and names no assertion.
const HINT_WAIT_MS = 2_000
const RECOVERY_WAIT_MS = 6_000
const TEST_TIMEOUT_MS = 15_000

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

interface InstanceSpec {blockId: string; instance?: string; children?: NodeSpec[]}
/** A block id — or, when the test needs a non-default render scope or a
 *  subtree, the long form. `setNavAttrs` defaults the scope to `i-<blockId>`. */
type NodeSpec = string | InstanceSpec

const appendInstance = (parent: HTMLElement, spec: NodeSpec): void => {
  const {blockId, instance, children}: InstanceSpec =
    typeof spec === 'string' ? {blockId: spec} : spec
  const el = document.createElement('div')
  setNavAttrs(el, blockId, instance)
  parent.appendChild(el)
  for (const child of children ?? []) appendInstance(el, child)
}

const buildPanelDom = (blocks: NodeSpec[]): HTMLElement => {
  const panel = document.createElement('div')
  panel.setAttribute('data-panel-id', PANEL_ID)
  for (const spec of blocks) appendInstance(panel, spec)
  document.body.appendChild(panel)
  return panel
}

const visibleRect = () =>
  ({
    top: 50,
    bottom: 1050,
    left: 0,
    right: 100,
    width: 100,
    height: 1000,
    x: 0,
    y: 50,
    toJSON: () => ({}),
  }) as DOMRect

const setNavAttrs = (el: HTMLElement, blockId: string, renderScopeId = `i-${blockId}`): void => {
  el.setAttribute('data-block-nav-item', 'true')
  el.setAttribute('data-block-id', blockId)
  el.setAttribute('data-render-scope-id', renderScopeId)
  el.setAttribute('data-block-surface', 'outline')
  el.getBoundingClientRect = visibleRect
}

const focusedLocation = (blockId: string, renderScopeId = `i-${blockId}`) => ({
  blockId,
  renderScopeId,
})

const setFocused = async (blockId: string, renderScopeId = `i-${blockId}`): Promise<void> => {
  await env.repo.block(PANEL_ID).set(focusedBlockLocationProp, focusedLocation(blockId, renderScopeId))
}

const expectRecoveredFocus = async (blockId: string): Promise<void> => {
  await waitFor(
    () => { expect(peekFocusedBlockLocation(env.repo.block(PANEL_ID))?.blockId).toBe(blockId) },
    {timeout: RECOVERY_WAIT_MS},
  )
}

/**
 * Fence a post-mount yank on the watchdog having adopted `blockId`: with no
 * stored hint for it the disappearance doesn't read as "the focused block
 * vanished", no recovery is armed, and the yank is one-shot. A non-null anchor
 * says the hint matches — not that the anchor is the right one, which only
 * the recovery assertion downstream pins.
 *
 * Satisfied on the first check today (the focus write's own awaits outlast
 * React's commit), so this is defence in depth for the PASS — but it is what
 * makes a broken hint refresh fail HERE, naming the cause, instead of six
 * seconds later on the recovery assertion. A focus write made BEFORE
 * `render()` needs no fence: it is already in the block cache, so the first
 * render's `usePropertyValue` returns it and the layout effect stores the
 * hint synchronously.
 */
const waitForRecoveryHint = async (blockId: string): Promise<void> => {
  await waitFor(
    () => {
      expect(findRecoveryAnchor(
        PANEL_ID,
        focusedLocation(blockId),
        resolveSpatialNavExclusions(env.repo.facetRuntime),
      )).not.toBeNull()
    },
    {timeout: HINT_WAIT_MS},
  )
}

let sharedDb: TestDb
let env: Harness
let panelBlock: Block
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  __resetSpatialNavigationForTesting()
  document.body.innerHTML = ''
  env = await setup()
  await env.repo.tx(async tx => {
    await tx.create({
      id: PANEL_ID,
      workspaceId: WS,
      parentId: null,
      orderKey: 'a0',
      properties: {
        [focusedBlockLocationProp.name]: focusedBlockLocationProp.codec.encode(focusedLocation('middle')),
      },
    })
    await tx.create({id: 'first', workspaceId: WS, parentId: null, orderKey: 'b0', content: 'first'})
    await tx.create({id: 'middle', workspaceId: WS, parentId: null, orderKey: 'b1', content: 'middle'})
    await tx.create({id: 'last', workspaceId: WS, parentId: null, orderKey: 'b2', content: 'last'})
  }, {scope: ChangeScope.UiState})
  panelBlock = env.repo.block(PANEL_ID)
})

afterEach(async () => {
  // Before `cleanup()`, which is where the per-test `finally` used to leave it.
  vi.useRealTimers()
  cleanup()
  __resetSpatialNavigationForTesting()
  document.body.innerHTML = ''
})

describe('PanelFocusRecovery', {timeout: TEST_TIMEOUT_MS}, () => {
  it("recovers to 'block previously below' when the focused block disappears", async () => {
    const panel = buildPanelDom(['first', 'middle', 'last'])

    render(<PanelFocusRecovery block={panelBlock}/>)

    // Sanity: focus is already on 'middle' and the instance is present.
    expect(peekFocusedBlockLocation(panelBlock)?.blockId).toBe('middle')

    // Simulate a backlink edited out so the entry no longer matches.
    panel.querySelector('[data-block-id="middle"]')!.remove()

    // Watchdog walks the sibling map — `last` was previously below
    // `middle`, so focus lands there.
    await expectRecoveredFocus('last')
  })

  it("falls to 'previously above' when the disappeared block was first in the panel", async () => {
    await setFocused('first')

    const panel = buildPanelDom(['first', 'middle', 'last'])

    render(<PanelFocusRecovery block={panelBlock}/>)

    // `first` has no "previously above", so the recovery falls through
    // to the next-sibling tier — landing on `middle`.
    panel.querySelector('[data-block-id="first"]')!.remove()

    await expectRecoveredFocus('middle')
  })

  it("focuses the parent on collapse (every child of the focused's parent unmounts together)", async () => {
    // Build nested DOM: panel > parent > [c1, focused, c3]. Collapsing
    // `parent` unmounts every child at once; neither sibling survives
    // but `parent` itself does, so it's the natural recovery target.
    await env.repo.tx(async tx => {
      await tx.create({id: 'parent', workspaceId: WS, parentId: null, orderKey: 'c0', content: 'parent'})
      await tx.create({id: 'c1', workspaceId: WS, parentId: 'parent', orderKey: 'd0', content: 'c1'})
      await tx.create({id: 'c3', workspaceId: WS, parentId: 'parent', orderKey: 'd2', content: 'c3'})
    }, {scope: ChangeScope.UiState})
    await setFocused('middle')

    const panel = buildPanelDom([
      {blockId: 'parent', children: ['c1', 'middle', 'c3']},
    ])

    render(<PanelFocusRecovery block={panelBlock}/>)

    // Collapse the parent: every child unmounts but parent stays.
    for (const blockId of ['c1', 'middle', 'c3']) {
      panel.querySelector(`[data-block-id="${blockId}"]`)!.remove()
    }

    await expectRecoveredFocus('parent')
  })

  it('does not misfire when the focused block was never mounted in this panel', async () => {
    // Focus points to a block id we've never seen in the panel. No
    // hint stored, location-match guard rejects fallback recovery, so no recovery.
    await setFocused('never-mounted')

    buildPanelDom(['first', 'middle'])


    // `focusBlock` is the only thing that opens a tx from here, so no tx is
    // "no recovery was attempted". Not restored: `beforeEach` mints a fresh
    // Repo, and `mockRestore` also clears the recorded calls this asserts on.
    const txSpy = vi.spyOn(env.repo, 'tx')
    vi.useFakeTimers()
    render(<PanelFocusRecovery block={panelBlock}/>)
    await act(async () => { await vi.advanceTimersByTimeAsync(DEBOUNCE_SETTLE_MS) })

    expect(txSpy).not.toHaveBeenCalled()
    expect(peekFocusedBlockLocation(panelBlock)?.blockId).toBe('never-mounted')
  })

  it("deleting a parent block lands focus on the same-depth next sibling, not on the parent's first child or the previous block", async () => {
    // Build the screenshot scenario:
    //   - above
    //   - parent          <- focused, gets deleted
    //     - child
    //     - c2
    //   - below
    // The previous (DOM-flat) algorithm would pick `child` as "next"
    // and then fall back to `above` when child disappears too; the
    // user expects `below`.
    await env.repo.tx(async tx => {
      await tx.create({id: 'topLevel', workspaceId: WS, parentId: null, orderKey: 'c0', content: 'top'})
      await tx.create({id: 'above', workspaceId: WS, parentId: 'topLevel', orderKey: 'd0', content: 'above'})
      await tx.create({id: 'below', workspaceId: WS, parentId: 'topLevel', orderKey: 'd9', content: 'below'})
    }, {scope: ChangeScope.UiState})
    await setFocused('parent')

    const panel = buildPanelDom([
      {blockId: 'topLevel', instance: 'i-top', children: [
        'above',
        {blockId: 'parent', children: ['child', 'c2']},
        'below',
      ]},
    ])

    render(<PanelFocusRecovery block={panelBlock}/>)

    // Delete `parent` and its subtree.
    panel.querySelector('[data-block-id="parent"]')!.remove()

    await expectRecoveredFocus('below')
  })

  it("collapsing a parent with an only child lands focus on the parent (consistent with multi-child collapse)", async () => {
    // panel > top > [above, parent > X, below]. X is the only child.
    // Same-depth siblings of X inside `parent`: none. So neither
    // sibling tier resolves, and we land on the ancestor (parent) —
    // matching the multi-child collapse case.
    await env.repo.tx(async tx => {
      await tx.create({id: 'topLevel', workspaceId: WS, parentId: null, orderKey: 'c0', content: 'top'})
      await tx.create({id: 'above', workspaceId: WS, parentId: 'topLevel', orderKey: 'd0', content: 'above'})
      await tx.create({id: 'parent', workspaceId: WS, parentId: 'topLevel', orderKey: 'd5', content: 'parent'})
      await tx.create({id: 'X', workspaceId: WS, parentId: 'parent', orderKey: 'e0', content: 'X'})
      await tx.create({id: 'below', workspaceId: WS, parentId: 'topLevel', orderKey: 'd9', content: 'below'})
    }, {scope: ChangeScope.UiState})
    await setFocused('X')

    const panel = buildPanelDom([
      {blockId: 'topLevel', children: [
        'above',
        {blockId: 'parent', children: ['X']},
        'below',
      ]},
    ])

    render(<PanelFocusRecovery block={panelBlock}/>)

    // Collapse: X unmounts, parent stays.
    panel.querySelector('[data-block-id="X"]')!.remove()

    await expectRecoveredFocus('parent')
  })

  it("does not recover when the focused block briefly leaves the DOM and returns (tab/shift-tab move)", async () => {
    const panel = buildPanelDom(['first', 'middle', 'last'])


    // Fake timers drive the debounce deterministically; nothing on this path
    // reaches the DB, so faking time is safe.
    const txSpy = vi.spyOn(env.repo, 'tx')
    vi.useFakeTimers()
    render(<PanelFocusRecovery block={panelBlock}/>)
    expect(peekFocusedBlockLocation(panelBlock)?.blockId).toBe('middle')

    // Simulate a tab move: the block briefly unmounts and remounts
    // under the same render scope well inside the debounce window. The
    // remove fire arms the debounce; advancing 20ms stays inside it.
    await act(async () => {
      panel.querySelector('[data-block-id="middle"]')!.remove()
      await vi.advanceTimersByTimeAsync(20)
    })

    // The remount's observer fire cancels the pending recovery; then
    // run past the full window to prove nothing fires.
    const replacement = document.createElement('div')
    setNavAttrs(replacement, 'middle')
    await act(async () => {
      panel.appendChild(replacement)
      await vi.advanceTimersByTimeAsync(DEBOUNCE_SETTLE_MS)
    })

    expect(txSpy).not.toHaveBeenCalled()
    expect(peekFocusedBlockLocation(panelBlock)?.blockId).toBe('middle')
  })

  it('keeps extending the debounce while the panel churns, then writes once it settles', async () => {
    // The component's contract for a re-render storm: every check cancels the
    // pending recovery and re-arms, so a steady stream of mutations pushes the
    // write out rather than letting it land on a half-settled layout.
    const panel = buildPanelDom(['first', 'middle', 'last'])

    const txSpy = vi.spyOn(env.repo, 'tx')
    vi.useFakeTimers()
    render(<PanelFocusRecovery block={panelBlock}/>)
    panel.querySelector('[data-block-id="middle"]')!.remove()

    // Three bursts, each inside the 250ms window but summing well past it.
    // A non-instance node is enough: the watcher keys off DOM churn in the
    // panel, not off what the churn contains.
    for (let burst = 0; burst < 3; burst++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200)
        panel.appendChild(document.createElement('div'))
      })
    }
    expect(txSpy).not.toHaveBeenCalled()

    await act(async () => { await vi.advanceTimersByTimeAsync(DEBOUNCE_SETTLE_MS) })
    expect(txSpy).toHaveBeenCalledTimes(1)

    // The write is unawaited, so it is still in flight here — settle it before
    // `beforeEach` resets the shared DB under it, and take the chance to check
    // WHAT it wrote, which the tx count alone doesn't. Real timers first: the
    // settle is the one thing in these tests that waits on wall clock.
    vi.useRealTimers()
    await expectRecoveredFocus('last')
  })

  it('does not recover when the panel element is replaced with the block still in it', async () => {
    // Swapping the element out from under the observer is the mechanical way
    // to reach the write-time re-check: the observer watches the element
    // `panelById` resolved at mount, so a block returning in a DIFFERENT
    // element fires nothing it can see and nothing cancels the armed recovery.
    // (Not a panel remount — this component mounts inside the panel div, so a
    // remount unmounts it and the cleanup clears the timer.)
    const panel = buildPanelDom(['first', 'middle', 'last'])

    const txSpy = vi.spyOn(env.repo, 'tx')
    vi.useFakeTimers()
    render(<PanelFocusRecovery block={panelBlock}/>)
    panel.querySelector('[data-block-id="middle"]')!.remove()
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })
    // Without this the assertion below passes for a panel that never armed
    // a recovery at all.
    expect(findRecoveryAnchor(
      PANEL_ID,
      focusedLocation('middle'),
      resolveSpatialNavExclusions(env.repo.facetRuntime),
    )).not.toBeNull()

    panel.remove()
    buildPanelDom(['first', 'middle', 'last'])

    await act(async () => { await vi.advanceTimersByTimeAsync(DEBOUNCE_SETTLE_MS) })
    expect(txSpy).not.toHaveBeenCalled()
  })

  it('refreshes the positional hint as the user navigates between blocks', async () => {
    const panel = buildPanelDom(['first', 'middle', 'last'])

    render(<PanelFocusRecovery block={panelBlock}/>)

    // Move focus to `last` — the watchdog should now consider `last`
    // the "current" block for recovery purposes.
    await panelBlock.set(focusedBlockLocationProp, focusedLocation('last'))

    await waitForRecoveryHint('last')

    // Yank `last`. Expected recovery target: `middle` (block above).
    panel.querySelector('[data-block-id="last"]')!.remove()

    await expectRecoveredFocus('middle')
  })
})
