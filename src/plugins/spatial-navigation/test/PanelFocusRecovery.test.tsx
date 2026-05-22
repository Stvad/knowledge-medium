// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { BlockCache } from '@/data/blockCache'
import { ChangeScope, type User } from '@/data/api'
import { Repo } from '@/data/repo'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { focusedBlockIdProp } from '@/data/properties'
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
    inst.setAttribute('data-block-instance', b.instance)
    inst.setAttribute('data-block-id', b.blockId)
    inst.setAttribute('data-block-surface', 'outline')
    panel.appendChild(inst)
  }
  document.body.appendChild(panel)
  return panel
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
        [focusedBlockIdProp.name]: focusedBlockIdProp.codec.encode('middle'),
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
    expect(panelBlock.peekProperty(focusedBlockIdProp)).toBe('middle')

    // Simulate a backlink edited out so the entry no longer matches.
    panel.querySelector('[data-block-id="middle"]')!.remove()

    // Watchdog walks the sibling map — `last` was previously below
    // `middle`, so focus lands there.
    await waitFor(() => {
      expect(panelBlock.peekProperty(focusedBlockIdProp)).toBe('last')
    })
  })

  it("falls to 'previously above' when the disappeared block was first in the panel", async () => {
    await env.repo.block(PANEL_ID).set(focusedBlockIdProp, 'first')

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
      expect(panelBlock.peekProperty(focusedBlockIdProp)).toBe('middle')
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
    await env.repo.block(PANEL_ID).set(focusedBlockIdProp, 'middle')

    const panel = document.createElement('div')
    panel.setAttribute('data-panel-id', PANEL_ID)
    const parent = document.createElement('div')
    parent.setAttribute('data-block-id', 'parent')
    parent.setAttribute('data-block-instance', 'i-parent')
    parent.setAttribute('data-block-surface', 'outline')
    panel.appendChild(parent)
    for (const blockId of ['c1', 'middle', 'c3']) {
      const child = document.createElement('div')
      child.setAttribute('data-block-id', blockId)
      child.setAttribute('data-block-instance', `i-${blockId}`)
      child.setAttribute('data-block-surface', 'outline')
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
      expect(panelBlock.peekProperty(focusedBlockIdProp)).toBe('parent')
    })
  })

  it('does not misfire when the focused block was never mounted in this panel', async () => {
    // Focus points to a block id we've never seen in the panel. No
    // hint stored, blockId-match guard rejects tier 3, so no recovery.
    await env.repo.block(PANEL_ID).set(focusedBlockIdProp, 'never-mounted')

    buildPanelDom(PANEL_ID, [
      {blockId: 'first', instance: 'i-first'},
      {blockId: 'middle', instance: 'i-middle'},
    ])

    const panelBlock = env.repo.block(PANEL_ID)
    render(<PanelFocusRecovery block={panelBlock}/>)

    // Give the layout effect + microtask + observer a tick to settle.
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(panelBlock.peekProperty(focusedBlockIdProp)).toBe('never-mounted')
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
    await panelBlock.set(focusedBlockIdProp, 'last')

    // Yank `last`. Expected recovery target: `middle` (block above).
    await waitFor(() => {
      panel.querySelector('[data-block-id="last"]')?.remove()
    })

    await waitFor(() => {
      expect(panelBlock.peekProperty(focusedBlockIdProp)).toBe('middle')
    })
  })
})
