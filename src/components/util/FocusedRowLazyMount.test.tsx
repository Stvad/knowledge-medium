// @vitest-environment happy-dom

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { ChangeScope, type User } from '@/data/api'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { focusBlock } from '@/data/properties'
import { FocusedRowLazyMount } from './FocusedRowLazyMount.tsx'
import {
  LazyViewportMount,
  __resetLazyMountCachesForTesting,
} from './LazyViewportMount.tsx'
import { __resetLazyMountRegistryForTesting, lazyBlockCacheKey } from './lazyMountRegistry.ts'

const WS = 'ws-1'
const USER: User = {id: 'user-1'}
const PANEL_ID = 'panel'

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
  it('leaves ancestors alone when the focused row is already rendered here', async () => {
    const panel = repo.block(PANEL_ID)
    render(
      <>
        <FocusedRowLazyMount block={panel} scopeRootId="top"/>
        <div data-block-id="nested" data-render-scope-id="panel:nested"/>
        <LazyViewportMount
          cacheKey={lazyBlockCacheKey('off-screen')}
          estimatedHeightPx={32}
          overscanPx={600}
          renderPlaceholder={() => <div data-testid="placeholder"/>}
        >
          <div data-testid="ancestor-row">ancestor</div>
        </LazyViewportMount>
      </>,
    )

    await focusBlock(panel, 'nested', {renderScopeId: 'panel:nested'})
    await new Promise(resolve => setTimeout(resolve, 400))

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

  // Mounting a row makes the focus decorator scroll it into view, so acting on
  // the value the panel MOUNTS with would yank the panel away from the scroll
  // position it just restored.
  it('ignores the focus value the panel mounts with', async () => {
    const panel = repo.block(PANEL_ID)
    await focusBlock(panel, 'off-screen', {renderScopeId: 'panel:off-screen'})

    render(
      <>
        <FocusedRowLazyMount block={panel} scopeRootId="top"/>
        <LazyViewportMount
          cacheKey={lazyBlockCacheKey('off-screen')}
          estimatedHeightPx={32}
          overscanPx={600}
          renderPlaceholder={() => <div data-testid="placeholder"/>}
        >
          <div data-testid="row">off-screen row</div>
        </LazyViewportMount>
      </>,
    )

    await new Promise(resolve => setTimeout(resolve, 400))

    expect(screen.getByTestId('placeholder')).toBeInTheDocument()
    expect(screen.queryByTestId('row')).not.toBeInTheDocument()
  })

  // ...but only on arrival. A permanent exemption would mean focus returning
  // to that block later never mounts its row — normal mode dead exactly
  // there, which is the bug this component exists to prevent.
  it('stops ignoring the arrival block once focus has moved away', async () => {
    const panel = repo.block(PANEL_ID)
    await focusBlock(panel, 'off-screen', {renderScopeId: 'panel:off-screen'})

    render(
      <>
        <FocusedRowLazyMount block={panel} scopeRootId="top"/>
        <LazyViewportMount
          cacheKey={lazyBlockCacheKey('off-screen')}
          estimatedHeightPx={32}
          overscanPx={600}
          renderPlaceholder={() => <div data-testid="placeholder"/>}
        >
          <div data-testid="row">off-screen row</div>
        </LazyViewportMount>
      </>,
    )

    await focusBlock(panel, 'top', {renderScopeId: 'panel:top'})
    await focusBlock(panel, 'off-screen', {renderScopeId: 'panel:off-screen'})

    await waitFor(() => {
      expect(screen.getByTestId('row')).toBeInTheDocument()
    })
  })
})
