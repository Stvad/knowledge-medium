// @vitest-environment happy-dom

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { ChangeScope, type User } from '@/data/api'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { focusBlock } from '@/data/properties'
import { FocusedRowLazyMount } from './FocusedRowLazyMount.tsx'
import { LazyViewportMount } from './LazyViewportMount.tsx'
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
  vi.stubGlobal('IntersectionObserver', NeverIntersectingObserver)
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: USER}).repo
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: PANEL_ID, workspaceId: WS, parentId: null, orderKey: 'a0'})
    await tx.create({id: 'off-screen', workspaceId: WS, parentId: null, orderKey: 'b0', content: 'off-screen'})
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
        <FocusedRowLazyMount block={panel}/>
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
})
