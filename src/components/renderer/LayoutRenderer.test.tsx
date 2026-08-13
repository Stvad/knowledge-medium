// @vitest-environment happy-dom

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { User } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { getLayoutSessionBlock, getUIStateBlock } from '@/data/stateBlocks'
import { BlockContextProvider, useBlockContext } from '@/context/block'
import { insertPanelRow, togglePanelMaximized } from '@/utils/panelLayoutProjection'
import { activePanelIdProp, panelMaximizedProp } from '@/data/properties'
import { LayoutRenderer } from './LayoutRenderer'

const isMobileRef = vi.hoisted(() => ({
  current: false,
}))

vi.mock('@/utils/react.tsx', () => ({
  useIsMobile: () => isMobileRef.current,
}))

vi.mock('@/components/BlockComponent.tsx', () => ({
  BlockComponent: ({blockId}: {blockId: string}) => {
    const context = useBlockContext()
    return (
      <div
        data-testid={`block-${blockId}`}
        data-stacked={String(Boolean(context.stackedPanel))}
        data-wide-scroll-surface={String(Boolean(context.wideScrollSurface))}
      />
    )
  },
}))

const WS = 'ws-1'
const USER: User = {id: 'user-1', name: 'Alice'}

interface Harness {
  h: TestDb
  repo: Repo
  layoutSessionBlockId: string
}

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const { repo } = createTestRepo({
    db: h.db,
    user: USER,
    startSyncObserver: false,
  })
  repo.setActiveWorkspaceId(WS)
  const uiState = await getUIStateBlock(repo, WS, USER, {})
  const layoutSessionBlock = await getLayoutSessionBlock(uiState, 'layout-session-a')
  return {h, repo, layoutSessionBlockId: layoutSessionBlock.id}
}

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

describe('LayoutRenderer', () => {
  let env: Harness

  beforeEach(async () => {
    isMobileRef.current = false
    env = await setup()
  })

  afterEach(async () => {
    cleanup()
  })

  const layoutSessionBlock = () => env.repo.block(env.layoutSessionBlockId)

  const renderLayout = (block = layoutSessionBlock()) =>
    render(
      <BlockContextProvider initialValue={{layoutBoundary: false}}>
        <LayoutRenderer block={block}/>
      </BlockContextProvider>,
    )

  it('marks a single top-level panel as a wide scroll surface', async () => {
    const panelId = await insertPanelRow(env.repo, layoutSessionBlock(), 'page-a')

    renderLayout()

    const renderedPanel = await screen.findByTestId(`block-${panelId}`)
    expect(renderedPanel).toHaveAttribute('data-wide-scroll-surface', 'true')
    expect(renderedPanel.parentElement?.className).not.toContain('max-w-3xl')
  })

  it('keeps normal column constraints when multiple top-level panels are present', async () => {
    const firstPanelId = await insertPanelRow(env.repo, layoutSessionBlock(), 'page-a')
    const secondPanelId = await insertPanelRow(env.repo, layoutSessionBlock(), 'page-b')

    renderLayout()

    const firstPanel = await screen.findByTestId(`block-${firstPanelId}`)
    const secondPanel = await screen.findByTestId(`block-${secondPanelId}`)
    expect(firstPanel).toHaveAttribute('data-wide-scroll-surface', 'false')
    expect(secondPanel).toHaveAttribute('data-wide-scroll-surface', 'false')
    expect(firstPanel.parentElement?.className).toContain('max-w-3xl')
    expect(secondPanel.parentElement?.className).toContain('max-w-3xl')
  })

  it('uses the wide scroll surface for the active mobile panel', async () => {
    isMobileRef.current = true
    await insertPanelRow(env.repo, layoutSessionBlock(), 'page-a')
    const secondPanelId = await insertPanelRow(env.repo, layoutSessionBlock(), 'page-b')

    renderLayout()

    expect(await screen.findByTestId(`block-${secondPanelId}`)).toHaveAttribute(
      'data-wide-scroll-surface',
      'true',
    )
  })

  describe('maximize', () => {
    const twoPanels = async () => ({
      first: await insertPanelRow(env.repo, layoutSessionBlock(), 'page-a'),
      second: await insertPanelRow(env.repo, layoutSessionBlock(), 'page-b'),
    })

    const setMaximized = (panelId: string, value: boolean) =>
      env.repo.block(panelId).set(panelMaximizedProp, value)

    it('renders a maximized panel alone, as a wide scroll surface', async () => {
      const {first, second} = await twoPanels()
      await setMaximized(second, true)

      renderLayout()

      const rendered = await screen.findByTestId(`block-${second}`)
      expect(rendered).toHaveAttribute('data-wide-scroll-surface', 'true')
      expect(screen.queryByTestId(`block-${first}`)).toBeNull()
    })

    it('restores the exact arrangement when the flag is cleared', async () => {
      const {first, second} = await twoPanels()
      await setMaximized(second, true)
      renderLayout()
      // Prove the hidden state first: a bare `queryByTestId(...).toBeNull()`
      // on a query-fed surface passes on the first render regardless.
      await screen.findByTestId(`block-${second}`)
      expect(screen.queryByTestId(`block-${first}`)).toBeNull()

      await setMaximized(second, false)

      expect(await screen.findByTestId(`block-${first}`)).toBeTruthy()
      expect(screen.getByTestId(`block-${second}`)).toBeTruthy()
    })

    it('renders the first maximized row when a hand-crafted hash flags several', async () => {
      const {first, second} = await twoPanels()
      await setMaximized(first, true)
      await setMaximized(second, true)

      renderLayout()

      await screen.findByTestId(`block-${first}`)
      expect(screen.queryByTestId(`block-${second}`)).toBeNull()
    })

    // Mobile's only observable coupling to the flag is the active-panel
    // coercion (the maximize render path is desktop-only and unreachable
    // here), and the coercion is an async write. So this asserts on the CAUSE
    // over a real window: a bare `queryByTestId(...).toBeNull()` right after
    // render stays green with the mobile guard deleted, because the coercion
    // had not landed yet. The sibling desktop test proves this same wait DOES
    // observe a coercion when one happens.
    it('ignores the flag on mobile, which already renders one panel', async () => {
      isMobileRef.current = true
      const {first, second} = await twoPanels()
      // `insertPanelRow` makes the LAST inserted panel active, so mobile shows
      // `second` — flag `first` and assert mobile never switches to it.
      await setMaximized(first, true)

      renderLayout()
      await screen.findByTestId(`block-${second}`)

      await expect(vi.waitFor(
        () => expect(layoutSessionBlock().peekProperty(activePanelIdProp)).toBe(first),
        {timeout: 500},
      )).rejects.toThrow()
      expect(screen.queryByTestId(`block-${first}`)).toBeNull()
    }, 20_000) // measured ~600ms: the negative wait above dominates

    it('coerces a gestureless maximized arrival to be the active panel', async () => {
      const {first, second} = await twoPanels()
      expect(layoutSessionBlock().peekProperty(activePanelIdProp)).toBe(second)
      // A URL / Back / snapshot arrival sets the row flag and nothing else.
      await setMaximized(first, true)

      renderLayout()

      await vi.waitFor(() =>
        expect(layoutSessionBlock().peekProperty(activePanelIdProp)).toBe(first))
    })

    it('does not fight the gesture: toggling already activates the pane it maximizes', async () => {
      const {first, second} = await twoPanels()

      expect(await togglePanelMaximized(env.repo, first)).toBe(true)

      expect(layoutSessionBlock().peekProperty(activePanelIdProp)).toBe(first)
      expect(env.repo.block(second).peekProperty(panelMaximizedProp)).not.toBe(true)
    })
  })
})
