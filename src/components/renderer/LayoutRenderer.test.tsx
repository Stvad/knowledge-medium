// @vitest-environment happy-dom

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { User } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { Block } from '@/data/block'
import { getLayoutSessionBlock, getUIStateBlock } from '@/data/stateBlocks'
import { BlockContextProvider, useBlockContext } from '@/context/block'
import { insertPanelRow, insertSidebarStackedPanel } from '@/utils/panelLayoutProjection'
import { activePanelIdProp, panelMaximizedProp } from '@/data/properties'
import { LayoutRenderer } from './LayoutRenderer'

const isMobileRef = vi.hoisted(() => ({
  current: false,
}))

vi.mock('@/utils/react.tsx', () => ({
  useIsMobile: () => isMobileRef.current,
}))

// `LayoutRenderer` decides from the SYNCHRONOUS media read, not the hook —
// `useMedia` reports its default on the first render, which on a phone is one
// commit of believing it is desktop. So the viewport has to be stubbed at the
// media query, not just at the hook, or these tests exercise a viewport the
// component does not see.
const stubMatchMedia = () => vi.stubGlobal('matchMedia', (media: string) => ({
  media,
  get matches() { return isMobileRef.current },
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  onchange: null,
  dispatchEvent: () => false,
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
    stubMatchMedia()
    env = await setup()
  })

  afterEach(async () => {
    cleanup()
    vi.unstubAllGlobals()
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

    // Narrowing to the solo pane must PRUNE the tree to the path that reaches
    // it, not hoist the leaf out of its stack. React identity is parent +
    // key, so re-parenting a stacked pane to the top level unmounts and
    // remounts it — dropping local editor state and, for the feature this
    // whole PR exists to serve, restarting video playback.
    //
    // Asserted on DOM-node identity rather than structure: a remount builds a
    // new node, so `toBe` is the direct question, and it cannot pass for a
    // structural reason that happens to look right.
    it('keeps a stacked pane mounted across maximize instead of re-parenting it', async () => {
      const top = await insertPanelRow(env.repo, layoutSessionBlock(), 'page-a')
      const stackedFirst = await insertSidebarStackedPanel(
        env.repo, layoutSessionBlock(), 'page-b', {sourcePanelId: top})
      const stackedSecond = await insertSidebarStackedPanel(
        env.repo, layoutSessionBlock(), 'page-c', {sourcePanelId: stackedFirst})

      renderLayout()
      const before = await screen.findByTestId(`block-${stackedFirst}`)

      await setMaximized(stackedFirst, true)
      // Fence on the maximize LANDING before the identity check, or that check
      // just reads the pre-maximize tree and passes for free.
      await waitFor(() => {
        expect(screen.queryByTestId(`block-${stackedSecond}`)).toBeNull()
        expect(screen.queryByTestId(`block-${top}`)).toBeNull()
      })

      expect(screen.getByTestId(`block-${stackedFirst}`)).toBe(before)
    })

    // A maximized pane should look the same wherever it lives — the surviving
    // stack wrapper must not keep imposing its column constraint on it.
    it('gives a maximized stacked pane the same wide surface as a top-level one', async () => {
      const top = await insertPanelRow(env.repo, layoutSessionBlock(), 'page-a')
      const stacked = await insertSidebarStackedPanel(
        env.repo, layoutSessionBlock(), 'page-b', {sourcePanelId: top})
      await setMaximized(stacked, true)

      renderLayout()

      const rendered = await screen.findByTestId(`block-${stacked}`)
      expect(rendered).toHaveAttribute('data-wide-scroll-surface', 'true')
      expect(screen.queryByTestId(`block-${top}`)).toBeNull()
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

    // The mobile solo pane is DERIVED from the pointer, so it must never be
    // treated as a coercion source: a pointer naming a row this snapshot does
    // not carry yet would otherwise be overwritten with the fallback pane, and
    // the row it named never becomes active when it does arrive.
    it('does not overwrite a mobile pointer that names a not-yet-projected row', async () => {
      isMobileRef.current = true
      await twoPanels()
      const notYetProjected = 'panel-row-arriving-later'
      await layoutSessionBlock().set(activePanelIdProp, notYetProjected)

      renderLayout()
      // Mobile renders SOME pane; wait for the commit before judging the write.
      await screen.findByTestId(/^block-/)

      await expect(vi.waitFor(
        () => expect(layoutSessionBlock().peekProperty(activePanelIdProp)).not.toBe(notYetProjected),
        {timeout: 500},
      )).rejects.toThrow()
    }, 20_000) // measured ~600ms: the negative wait dominates

    it('coerces a gestureless maximized arrival to be the active panel', async () => {
      const {first, second} = await twoPanels()
      expect(layoutSessionBlock().peekProperty(activePanelIdProp)).toBe(second)
      // A URL / Back / snapshot arrival sets the row flag and nothing else.
      await setMaximized(first, true)

      renderLayout()

      await vi.waitFor(() =>
        expect(layoutSessionBlock().peekProperty(activePanelIdProp)).toBe(first))
    })

    // The seed-the-pointer rule fires only on an ABSENT pointer. A pointer
    // naming a row this subtree doesn't have is left alone: the row may simply
    // not be projected yet, and seizing it would move the user's active pane.
    // Row deletion has its own repair, so nothing needs this path to clean up.
    it('leaves a pointer naming an unknown row alone rather than seizing it', async () => {
      const {first} = await twoPanels()
      const foreign = 'panel-row-from-another-session'
      await layoutSessionBlock().set(activePanelIdProp, foreign)

      renderLayout()
      await screen.findByTestId(`block-${first}`)

      // Negative over a real window: the seize would be an async write, so a
      // bare assertion right after render passes either way.
      await expect(vi.waitFor(
        () => expect(layoutSessionBlock().peekProperty(activePanelIdProp)).not.toBe(foreign),
        {timeout: 500},
      )).rejects.toThrow()
    }, 20_000) // measured ~600ms: the negative wait dominates

    // The insert clears the flag, creates the row, and moves `active` onto the
    // new pane in ONE tx — but the renderer used to read `activePanelId` from
    // a separate subscription, so it could see the new pointer against the OLD
    // flagged rows and write `active` straight back to the maximized pane.
    // Only reproduces with the renderer MOUNTED (its effect is the clobberer),
    // which is why the projection-level insert test cannot cover it.
    it('lets an insert under a maximize keep the new pane active', async () => {
      const {first, second} = await twoPanels()
      await setMaximized(first, true)
      renderLayout()
      await screen.findByTestId(`block-${first}`)
      expect(screen.queryByTestId(`block-${second}`)).toBeNull()

      const inserted = await insertPanelRow(env.repo, layoutSessionBlock(), 'page-c')

      expect(await screen.findByTestId(`block-${inserted}`)).toBeTruthy()
      // Give the effect every chance to clobber before believing it didn't.
      await expect(vi.waitFor(
        () => expect(layoutSessionBlock().peekProperty(activePanelIdProp)).not.toBe(inserted),
        {timeout: 500},
      )).rejects.toThrow()
      expect(screen.getByTestId(`block-${first}`)).toBeTruthy()
    }, 20_000) // measured ~600ms: the negative wait dominates

    // With activePanelId UNSET — the shipped shape of a shared `…;max` link,
    // since reconcile leaves the pointer alone — the coercion effect and the
    // fallback-active effect both fire in the same commit. A fallback of
    // `panelSlots[0]` disagreed with the coercion, so activePanelId briefly
    // named a pane that isn't rendered, then took three writes to settle.
    it('seeds active to the maximized pane, not the first one, on a gestureless arrival', async () => {
      const {second} = await twoPanels()
      await setMaximized(second, true)
      await layoutSessionBlock().set(activePanelIdProp, undefined)
      // Record every value written, not just the settled one: the bug settled
      // correctly too, it just went via the wrong pane first. Capture the
      // original BEFORE spying — reaching for `Block.prototype.set` inside the
      // implementation would re-enter the spy.
      const writes: unknown[] = []
      const originalSet = Block.prototype.set
      const setSpy = vi.spyOn(Block.prototype, 'set').mockImplementation(
        function (this: Block, prop: never, value: never) {
          if (prop === activePanelIdProp) writes.push(value)
          return originalSet.call(this, prop, value)
        } as typeof Block.prototype.set,
      )

      try {
        renderLayout()

        await vi.waitFor(() =>
          expect(layoutSessionBlock().peekProperty(activePanelIdProp)).toBe(second))
      } finally {
        // `mockRestore` as a bare statement leaks the prototype patch to every
        // later test in the file whenever the wait above throws.
        setSpy.mockRestore()
      }
      // It must never have passed THROUGH the first pane on the way, and must
      // not have taken repeated writes to settle.
      expect(writes).toEqual([second])
    })
  })
})
