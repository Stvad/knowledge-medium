// @vitest-environment happy-dom

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { ChangeScope, type User } from '@/data/api'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { focusBlock, focusedBlockLocationProp, topLevelBlockIdProp } from '@/data/properties'
import { usePropertyValue } from '@/hooks/block.js'
import { FocusedRowLazyMount } from './FocusedRowLazyMount.tsx'
import {
  LazyViewportMount,
  __resetLazyMountCachesForTesting,
} from './LazyViewportMount.tsx'
import { __resetLazyMountRegistryForTesting, lazyBlockCacheKey } from './lazyMountRegistry.ts'

const WS = 'ws-1'
const USER: User = {id: 'user-1'}
const PANEL_ID = 'panel'
const PANEL_ID_2 = 'panel-2'

/** Never intersects on its own — the row stays a placeholder until something
 *  asks it to mount, which is the state a row below the fold is in. */
class NeverIntersectingObserver {
  constructor(readonly callback: IntersectionObserverCallback) {}
  observe(): void {}
  disconnect(): void {}
}

let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  __resetLazyMountRegistryForTesting()
  __resetLazyMountCachesForTesting()
  vi.stubGlobal('IntersectionObserver', NeverIntersectingObserver)
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: USER}).repo
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: PANEL_ID, workspaceId: WS, parentId: null, orderKey: 'a0'})
    await tx.create({id: 'top', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'top'})
    await tx.create({id: 'off-screen', workspaceId: WS, parentId: 'top', orderKey: 'b0', content: 'off-screen'})
    // Nested one level deeper: its lazy wrapper only exists once `off-screen`
    // mounts, so reaching it needs the ancestor walk.
    await tx.create({id: 'nested', workspaceId: WS, parentId: 'off-screen', orderKey: 'c0', content: 'nested'})
    // Fence targets for the negative tests: rows that ARE expected to mount,
    // so "the other one didn't" is an observation rather than a race with the
    // property subscription. `fence-parent`/`fence-nested` mirror the
    // off-screen/nested pair so the fence runs the same delayed walk.
    await tx.create({id: 'control', workspaceId: WS, parentId: 'top', orderKey: 'b1', content: 'control'})
    await tx.create({id: 'fence-parent', workspaceId: WS, parentId: 'top', orderKey: 'b2', content: 'fence parent'})
    await tx.create({id: 'fence-nested', workspaceId: WS, parentId: 'fence-parent', orderKey: 'c1', content: 'fence nested'})
    await tx.create({id: PANEL_ID_2, workspaceId: WS, parentId: null, orderKey: 'a2'})
    // A second page, for the back/forward content-swap case: the panel keeps
    // this component and only swaps `scopeRootId`.
    await tx.create({id: 'top2', workspaceId: WS, parentId: null, orderKey: 'a3', content: 'page 2'})
    await tx.create({id: 'page2-row', workspaceId: WS, parentId: 'top2', orderKey: 'd0', content: 'page 2 row'})
    await tx.create({id: 'page2-control', workspaceId: WS, parentId: 'top2', orderKey: 'd1', content: 'page 2 control'})
  }, {scope: ChangeScope.UiState})
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('FocusedRowLazyMount', () => {
  // Keyboard navigation resolves its target from the block model, which knows
  // nothing about which rows happen to be mounted. Without this, focus lands
  // on a placeholder: no shell, so no highlight, no DOM focus, no
  // scroll-into-view, and normal mode (gated on `useInFocus`) goes quiet.
  it('mounts the panel\'s focused row when it is still a placeholder', async () => {
    const panel = repo.block(PANEL_ID)
    render(
      <>
        <FocusedRowLazyMount block={panel} scopeRootId="top"/>
        <LazyViewportMount
          cacheKey={lazyBlockCacheKey('off-screen')}
          blockId="off-screen"
          estimatedHeightPx={32}
          overscanPx={600}
          renderPlaceholder={() => <div data-testid="placeholder"/>}
        >
          <div data-testid="row">off-screen row</div>
        </LazyViewportMount>
      </>,
    )

    expect(screen.getByTestId('placeholder')).toBeInTheDocument()

    await focusBlock(panel, 'off-screen', {renderScopeId: 'panel:off-screen'})

    await waitFor(() => {
      expect(screen.getByTestId('row')).toBeInTheDocument()
    })
  })

  // Focus can move to a nested row whose ANCESTOR is deferred: the target has
  // no placeholder to reach, because a child's lazy wrapper only renders once
  // its parent mounts. Wanting the ancestors makes the cascade resolve itself.
  it('mounts the ancestor chain when the focused row has no placeholder yet', async () => {
    const panel = repo.block(PANEL_ID)
    // Only the ancestor is rendered; `nested` has no wrapper at all, exactly
    // as in the real tree before `off-screen` mounts.
    render(
      <>
        <FocusedRowLazyMount block={panel} scopeRootId="top"/>
        <LazyViewportMount
          cacheKey={lazyBlockCacheKey('off-screen')}
          blockId="off-screen"
          estimatedHeightPx={32}
          overscanPx={600}
          renderPlaceholder={() => <div data-testid="placeholder"/>}
        >
          <div data-testid="ancestor-row">ancestor</div>
        </LazyViewportMount>
      </>,
    )

    expect(screen.getByTestId('placeholder')).toBeInTheDocument()

    await focusBlock(panel, 'nested', {renderScopeId: 'panel:nested'})

    await waitFor(() => {
      expect(screen.getByTestId('ancestor-row')).toBeInTheDocument()
    }, {timeout: 3000})
  })

  // The row is already rendered in THIS panel, so nothing needs forcing —
  // the ancestor walk must not run and drag unrelated rows in with it.
  //
  // Fenced with a SECOND panel rather than a sleep: its focused row has no
  // rendered copy, so its walk must run, and both walks are armed in the same
  // tick with the same delay. Once the fence row appears, the subject's walk
  // has demonstrably had its turn. (Fencing on the same panel would not work
  // — changing that panel's focus cancels the very timer under test.)
  it('leaves ancestors alone when the focused row is already rendered here', async () => {
    const panel = repo.block(PANEL_ID)
    const fencePanel = repo.block(PANEL_ID_2)
    await focusBlock(panel, 'nested', {renderScopeId: 'panel:nested'})
    await focusBlock(fencePanel, 'fence-nested', {renderScopeId: 'panel2:fence-nested'})

    render(
      <>
        <FocusedRowLazyMount block={panel} scopeRootId="top"/>
        <FocusedRowLazyMount block={fencePanel} scopeRootId="top"/>
        <div data-block-id="nested" data-render-scope-id="panel:nested"/>
        <LazyViewportMount
          cacheKey={lazyBlockCacheKey('off-screen')}
          blockId="off-screen"
          estimatedHeightPx={32}
          overscanPx={600}
          renderPlaceholder={() => <div data-testid="placeholder"/>}
        >
          <div data-testid="ancestor-row">ancestor</div>
        </LazyViewportMount>
        <LazyViewportMount
          cacheKey={lazyBlockCacheKey('fence-parent')}
          blockId="fence-parent"
          estimatedHeightPx={32}
          overscanPx={600}
          renderPlaceholder={() => <div data-testid="fence-placeholder"/>}
        >
          <div data-testid="fence-row">fence</div>
        </LazyViewportMount>
      </>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('fence-row')).toBeInTheDocument()
    }, {timeout: 3000})

    expect(screen.getByTestId('placeholder')).toBeInTheDocument()
    expect(screen.queryByTestId('ancestor-row')).not.toBeInTheDocument()
  })

  // `data-block-id` is also on other panels' rows, on inline reference links
  // and on property rows, so the "already rendered" probe has to match THIS
  // panel's render scope — otherwise another panel's copy suppresses the
  // cascade for a row that genuinely isn't here.
  it('walks anyway when the only rendered copy belongs to another scope', async () => {
    const panel = repo.block(PANEL_ID)
    render(
      <>
        <FocusedRowLazyMount block={panel} scopeRootId="top"/>
        <div data-block-id="nested" data-render-scope-id="some-other-panel"/>
        <LazyViewportMount
          cacheKey={lazyBlockCacheKey('off-screen')}
          blockId="off-screen"
          estimatedHeightPx={32}
          overscanPx={600}
          renderPlaceholder={() => <div data-testid="placeholder"/>}
        >
          <div data-testid="ancestor-row">ancestor</div>
        </LazyViewportMount>
      </>,
    )

    await focusBlock(panel, 'nested', {renderScopeId: 'panel:nested'})

    await waitFor(() => {
      expect(screen.getByTestId('ancestor-row')).toBeInTheDocument()
    }, {timeout: 3000})
  })

  // The value a panel arrives with is the cursor a restore puts back, and
  // `PanelRenderer` scrolls TO that row — so it has to exist. It used to be
  // exempt here, to keep the mount-scroll off a pixel `scrollTop` restore that
  // disagreed with it; restoring by the cursor removed the conflict, and with
  // it the cost — a restored panel stayed keyboard-dead (normal mode needs a
  // mounted focused row) until the user clicked.
  //
  // Under `StrictMode` deliberately, matching `main.tsx`: it double-invokes the
  // effect, and the mount path is where a re-entry guard would go wrong.
  it('mounts the focus value the panel arrives with', async () => {
    const panel = repo.block(PANEL_ID)
    await focusBlock(panel, 'off-screen', {renderScopeId: 'panel:off-screen'})

    render(
      <StrictMode>
        <FocusedRowLazyMount block={panel} scopeRootId="top"/>
        <LazyViewportMount
          cacheKey={lazyBlockCacheKey('off-screen')}
          blockId="off-screen"
          estimatedHeightPx={32}
          overscanPx={600}
          renderPlaceholder={() => <div data-testid="placeholder"/>}
        >
          <div data-testid="row">off-screen row</div>
        </LazyViewportMount>
      </StrictMode>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('row')).toBeInTheDocument()
    })
  })

  // A backlink entry keys its placeholder `backlink:<scope>:<id>` so its sticky
  // mounted-state and measured height stay per-entry. A caller holding only a
  // focused location can't reconstruct that key, so before the registry
  // registered under the canonical block key as well, a cursor restored onto a
  // deferred backlink row could not be materialized at all — keyboard nav dead
  // there, and a scroll restore anchored to it silently giving up.
  it("mounts a focused row whose surface mints its own cache key", async () => {
    const panel = repo.block(PANEL_ID)
    render(
      <>
        <FocusedRowLazyMount block={panel} scopeRootId="top"/>
        <LazyViewportMount
          cacheKey={`backlink:entry-1:off-screen`}
          blockId="off-screen"
          estimatedHeightPx={32}
          overscanPx={600}
          renderPlaceholder={() => <div data-testid="placeholder"/>}
        >
          <div data-testid="row">backlink row</div>
        </LazyViewportMount>
      </>,
    )

    expect(screen.getByTestId('placeholder')).toBeInTheDocument()

    await focusBlock(panel, 'off-screen', {renderScopeId: 'backlink:entry-1'})

    await waitFor(() => {
      expect(screen.getByTestId('row')).toBeInTheDocument()
    })
  })

  // Back/forward keeps this component and swaps `scopeRootId` — the restored
  // page's focus arrives the same way a reload's does, in one tx with the new
  // top-level block. The row has to mount there too, or the restore has
  // nothing to scroll to.
  it('mounts the restored focus row when the panel swaps to another page', async () => {
    const panel = repo.block(PANEL_ID)
    await focusBlock(panel, 'off-screen', {renderScopeId: 'panel:off-screen'})
    await panel.set(topLevelBlockIdProp, 'top')

    // Take `scopeRootId` from the panel block, as `PanelRenderer` does, so the
    // swap below lands both props in ONE commit — which is what makes the
    // arrival value visible on the same render as the new scope.
    const PanelHarness = () => {
      const [topLevelBlockId] = usePropertyValue(panel, topLevelBlockIdProp)
      return <FocusedRowLazyMount block={panel} scopeRootId={topLevelBlockId ?? 'top'}/>
    }
    const tree = () => (
      <>
        <PanelHarness/>
        <LazyViewportMount
          cacheKey={lazyBlockCacheKey('page2-row')}
          blockId="page2-row"
          estimatedHeightPx={32}
          overscanPx={600}
          renderPlaceholder={() => <div data-testid="page2-placeholder"/>}
        >
          <div data-testid="page2-row">page 2 row</div>
        </LazyViewportMount>
        <LazyViewportMount
          cacheKey={lazyBlockCacheKey('page2-control')}
          blockId="page2-control"
          estimatedHeightPx={32}
          overscanPx={600}
          renderPlaceholder={() => <div data-testid="page2-control-placeholder"/>}
        >
          <div data-testid="page2-control-row">page 2 control</div>
        </LazyViewportMount>
      </>
    )
    render(tree())

    // The swap itself: new top-level block AND that page's restored focus in
    // one tx, exactly as `writePanelContent` writes them.
    await act(async () => {
      await repo.tx(async tx => {
        await tx.setProperty(PANEL_ID, topLevelBlockIdProp, 'top2')
        await tx.setProperty(PANEL_ID, focusedBlockLocationProp, {
          blockId: 'page2-row',
          renderScopeId: 'panel:page2-row',
        })
      }, {scope: ChangeScope.UiState})
    })

    await waitFor(() => {
      expect(screen.getByTestId('page2-row')).toBeInTheDocument()
    })
    // The pane's own control row is untouched: this wants the CURSOR's row,
    // not every row on the new page.
    expect(screen.getByTestId('page2-control-placeholder')).toBeInTheDocument()
  })
})
