// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { BlockCache } from '@/data/blockCache'
import { ChangeScope, type User } from '@/data/api'
import { Repo } from '@/data/repo'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import {
  focusedBlockLocationProp,
  peekFocusedBlockLocation,
} from '@/data/properties'
import { PanelFocusRecovery } from '../PanelFocusRecovery.tsx'
import { __resetSpatialNavigationForTesting } from '../walker.ts'

const WS = 'ws-1'
const USER: User = {id: 'user-1'}
const PANEL_ID = 'panel'

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

const buildPanelDom = (
  panelId: string,
  blocks: Array<{blockId: string; instance: string}>,
): HTMLElement => {
  const panel = document.createElement('div')
  panel.setAttribute('data-panel-id', panelId)
  for (const b of blocks) {
    const inst = document.createElement('div')
    setNavAttrs(inst, b.blockId, b.instance)
    panel.appendChild(inst)
  }
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

let env: Harness

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
})

afterEach(async () => {
  cleanup()
  __resetSpatialNavigationForTesting()
  document.body.innerHTML = ''
  await env.h.cleanup()
})

describe('PanelFocusRecovery', () => {
  it("recovers to 'block previously below' when the focused block disappears", async () => {
    const panel = buildPanelDom(PANEL_ID, [
      {blockId: 'first', instance: 'i-first'},
      {blockId: 'middle', instance: 'i-middle'},
      {blockId: 'last', instance: 'i-last'},
    ])

    const panelBlock = env.repo.block(PANEL_ID)
    render(<PanelFocusRecovery block={panelBlock}/>)

    // Sanity: focus is already on 'middle' and the instance is present.
    expect(peekFocusedBlockLocation(panelBlock)?.blockId).toBe('middle')

    // Simulate a backlink edited out so the entry no longer matches.
    panel.querySelector('[data-block-id="middle"]')!.remove()

    // Watchdog walks the sibling map — `last` was previously below
    // `middle`, so focus lands there.
    await waitFor(() => {
      expect(peekFocusedBlockLocation(panelBlock)?.blockId).toBe('last')
    })
  })

  it("falls to 'previously above' when the disappeared block was first in the panel", async () => {
    await setFocused('first')

    const panel = buildPanelDom(PANEL_ID, [
      {blockId: 'first', instance: 'i-first'},
      {blockId: 'middle', instance: 'i-middle'},
      {blockId: 'last', instance: 'i-last'},
    ])

    const panelBlock = env.repo.block(PANEL_ID)
    render(<PanelFocusRecovery block={panelBlock}/>)

    // `first` has no "previously above", so the recovery falls through
    // to the next-sibling tier — landing on `middle`.
    panel.querySelector('[data-block-id="first"]')!.remove()

    await waitFor(() => {
      expect(peekFocusedBlockLocation(panelBlock)?.blockId).toBe('middle')
    })
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

    const panel = document.createElement('div')
    panel.setAttribute('data-panel-id', PANEL_ID)
    const parent = document.createElement('div')
    setNavAttrs(parent, 'parent')
    panel.appendChild(parent)
    for (const blockId of ['c1', 'middle', 'c3']) {
      const child = document.createElement('div')
      setNavAttrs(child, blockId)
      parent.appendChild(child)
    }
    document.body.appendChild(panel)

    const panelBlock = env.repo.block(PANEL_ID)
    render(<PanelFocusRecovery block={panelBlock}/>)

    // Collapse the parent: every child unmounts but parent stays.
    for (const blockId of ['c1', 'middle', 'c3']) {
      panel.querySelector(`[data-block-id="${blockId}"]`)!.remove()
    }

    await waitFor(() => {
      expect(peekFocusedBlockLocation(panelBlock)?.blockId).toBe('parent')
    })
  })

  it('does not misfire when the focused block was never mounted in this panel', async () => {
    // Focus points to a block id we've never seen in the panel. No
    // hint stored, location-match guard rejects fallback recovery, so no recovery.
    await setFocused('never-mounted')

    buildPanelDom(PANEL_ID, [
      {blockId: 'first', instance: 'i-first'},
      {blockId: 'middle', instance: 'i-middle'},
    ])

    const panelBlock = env.repo.block(PANEL_ID)
    render(<PanelFocusRecovery block={panelBlock}/>)

    // Give the layout effect + microtask + observer + debounce a tick
    // to settle.
    await new Promise(resolve => setTimeout(resolve, 350))

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

    const panel = document.createElement('div')
    panel.setAttribute('data-panel-id', PANEL_ID)
    const top = document.createElement('div')
    setNavAttrs(top, 'topLevel', 'i-top')
    panel.appendChild(top)

    const above = document.createElement('div')
    setNavAttrs(above, 'above')
    top.appendChild(above)

    const parent = document.createElement('div')
    setNavAttrs(parent, 'parent')
    top.appendChild(parent)
    for (const blockId of ['child', 'c2']) {
      const child = document.createElement('div')
      setNavAttrs(child, blockId)
      parent.appendChild(child)
    }

    const below = document.createElement('div')
    setNavAttrs(below, 'below')
    top.appendChild(below)

    document.body.appendChild(panel)

    const panelBlock = env.repo.block(PANEL_ID)
    render(<PanelFocusRecovery block={panelBlock}/>)

    // Delete `parent` and its subtree.
    panel.querySelector('[data-block-id="parent"]')!.remove()

    await waitFor(() => {
      expect(peekFocusedBlockLocation(panelBlock)?.blockId).toBe('below')
    })
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

    const panel = document.createElement('div')
    panel.setAttribute('data-panel-id', PANEL_ID)

    const mkInstance = (blockId: string): HTMLElement => {
      const el = document.createElement('div')
      setNavAttrs(el, blockId)
      return el
    }

    const top = mkInstance('topLevel')
    panel.appendChild(top)
    top.appendChild(mkInstance('above'))
    const parent = mkInstance('parent')
    top.appendChild(parent)
    parent.appendChild(mkInstance('X'))
    top.appendChild(mkInstance('below'))

    document.body.appendChild(panel)

    const panelBlock = env.repo.block(PANEL_ID)
    render(<PanelFocusRecovery block={panelBlock}/>)

    // Collapse: X unmounts, parent stays.
    panel.querySelector('[data-block-id="X"]')!.remove()

    await waitFor(() => {
      expect(peekFocusedBlockLocation(panelBlock)?.blockId).toBe('parent')
    })
  })

  it("does not recover when the focused block briefly leaves the DOM and returns (tab/shift-tab move)", async () => {
    const panel = buildPanelDom(PANEL_ID, [
      {blockId: 'first', instance: 'i-first'},
      {blockId: 'middle', instance: 'i-middle'},
      {blockId: 'last', instance: 'i-last'},
    ])

    const panelBlock = env.repo.block(PANEL_ID)
    render(<PanelFocusRecovery block={panelBlock}/>)
    expect(peekFocusedBlockLocation(panelBlock)?.blockId).toBe('middle')

    // Simulate a tab move: the block briefly unmounts and remounts
    // under the same render scope well inside the debounce window.
    panel.querySelector('[data-block-id="middle"]')!.remove()
    await new Promise(resolve => setTimeout(resolve, 20))

    const replacement = document.createElement('div')
    setNavAttrs(replacement, 'middle')
    panel.appendChild(replacement)

    // Wait past the debounce window and verify no recovery write fired.
    await new Promise(resolve => setTimeout(resolve, 350))

    expect(peekFocusedBlockLocation(panelBlock)?.blockId).toBe('middle')
  })

  it('refreshes the positional hint as the user navigates between blocks', async () => {
    const panel = buildPanelDom(PANEL_ID, [
      {blockId: 'first', instance: 'i-first'},
      {blockId: 'middle', instance: 'i-middle'},
      {blockId: 'last', instance: 'i-last'},
    ])

    const panelBlock = env.repo.block(PANEL_ID)
    render(<PanelFocusRecovery block={panelBlock}/>)

    // Move focus to `last` — the watchdog should now consider `last`
    // the "current" block for recovery purposes.
    await panelBlock.set(focusedBlockLocationProp, focusedLocation('last'))

    // Yank `last`. Expected recovery target: `middle` (block above).
    await waitFor(() => {
      panel.querySelector('[data-block-id="last"]')?.remove()
    })

    await waitFor(() => {
      expect(peekFocusedBlockLocation(panelBlock)?.blockId).toBe('middle')
    })
  })
})
