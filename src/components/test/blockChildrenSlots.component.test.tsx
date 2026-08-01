// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { Repo } from '@/data/repo.js'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb.js'
import { createTestRepo } from '@/data/test/createTestRepo'
import { BlockContextProvider } from '@/context/block'
import { BlockChildren } from '@/components/BlockComponent'
import { __resetLazyMountCachesForTesting } from '@/components/util/LazyViewportMount'
import { __resetLazyMountRegistryForTesting } from '@/components/util/lazyMountRegistry'

/** Never intersects, so every child stays a placeholder — the state whose DOM
 *  the spatial-navigation walker reads. */
class NeverIntersectingObserver {
  readonly observe = vi.fn()
  readonly disconnect = vi.fn()
}

const WS = 'ws-1'
const SCOPE = 'panel:p1:parent'

let sharedDb: TestDb
let repo: Repo
let originalMatchMedia: typeof window.matchMedia

beforeAll(async () => {
  sharedDb = await createTestDb()
  originalMatchMedia = window.matchMedia
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})
afterAll(async () => {
  window.matchMedia = originalMatchMedia
  await sharedDb.cleanup()
})

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}}).repo
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: 'parent', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'parent'})
    await tx.create({id: 'child', workspaceId: WS, parentId: 'parent', orderKey: 'a0', content: 'child'})
  }, {scope: ChangeScope.BlockDefault})
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  __resetLazyMountRegistryForTesting()
  __resetLazyMountCachesForTesting()
})

// The middle link of the deferred-row contract, and the one that used to be
// unpinned: `LazyViewportMount`'s own tests prove it writes the attributes when
// given a scope, and the walker's tests prove what it does with them — but
// nothing proved anyone SUPPLIES one. Dropping the prop here left every suite
// green while silently turning the feature off.
describe('BlockChildren — the scope a deferred row publishes', () => {
  it('labels a deferred child with the scope its row will render in', async () => {
    vi.stubGlobal('IntersectionObserver', NeverIntersectingObserver)

    const {container} = render(
      <BlockContextProvider initialValue={{renderScopeId: SCOPE}}>
        <BlockChildren block={repo.block('parent')}/>
      </BlockContextProvider>,
    )

    const slot = await vi.waitFor(() => {
      const found = container.querySelector<HTMLElement>('[data-lazy-block-id="child"]')
      expect(found).not.toBeNull()
      return found!
    })

    // Not the block id alone: the scope is what makes the slot usable, and it
    // has to be the one the row will actually mount into.
    expect(slot.dataset.lazyRenderScopeId).toBe(SCOPE)
  })
})
