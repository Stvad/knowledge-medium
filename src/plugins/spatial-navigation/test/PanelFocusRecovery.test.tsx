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
  it("recovers to 'block just above' when the focused block disappears from the panel DOM", async () => {
    const panel = buildPanelDom(PANEL_ID, [
      {blockId: 'first', instance: 'i-first'},
      {blockId: 'middle', instance: 'i-middle'},
      {blockId: 'last', instance: 'i-last'},
    ])

    const panelBlock = env.repo.block(PANEL_ID)
    render(<PanelFocusRecovery block={panelBlock}/>)

    // Sanity: focus is already on 'middle' and the instance is present.
    expect(panelBlock.peekProperty(focusedBlockIdProp)).toBe('middle')

    // Simulate the disappearance — the backlink rule no longer matches,
    // or the parent of `middle` got collapsed.
    panel.querySelector('[data-block-id="middle"]')!.remove()

    // The watchdog should write `first` (the block immediately above
    // where `middle` was) as the new focused block.
    await waitFor(() => {
      expect(panelBlock.peekProperty(focusedBlockIdProp)).toBe('first')
    })
  })

  it('lands on the next-down block when the disappeared block was first in the panel', async () => {
    // Re-point focus to `first` before mounting the watchdog so its
    // initial position-remember tracks `first` at index 0.
    await env.repo.block(PANEL_ID).set(focusedBlockIdProp, 'first')

    const panel = buildPanelDom(PANEL_ID, [
      {blockId: 'first', instance: 'i-first'},
      {blockId: 'middle', instance: 'i-middle'},
      {blockId: 'last', instance: 'i-last'},
    ])

    const panelBlock = env.repo.block(PANEL_ID)
    render(<PanelFocusRecovery block={panelBlock}/>)

    // Yank the focused block out of the DOM.
    panel.querySelector('[data-block-id="first"]')!.remove()

    // `first` was at idx 0; clamp(-1, 0, ...) = 0; remaining list
    // starts with `middle`, so we land there.
    await waitFor(() => {
      expect(panelBlock.peekProperty(focusedBlockIdProp)).toBe('middle')
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
