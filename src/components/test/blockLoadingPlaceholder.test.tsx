// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { BlockLoadingPlaceholder } from '../BlockLoadingPlaceholder.tsx'
import {
  LazyViewportMount,
  __resetLazyMountCachesForTesting,
} from '@/components/util/LazyViewportMount'
import { __resetLazyMountRegistryForTesting } from '@/components/util/lazyMountRegistry'
import { ownsGestureTarget } from '@/extensions/blockInteraction'

/** Never intersects, so the row stays a placeholder — the state under test. */
class NoopIntersectionObserver {
  observe = vi.fn()
  disconnect = vi.fn()
}

afterEach(() => {
  cleanup()
  __resetLazyMountCachesForTesting()
  __resetLazyMountRegistryForTesting()
  vi.unstubAllGlobals()
})

// A container that mounts real rows (a review backlog, a recents list) shows
// placeholders for the ones below the fold. Those stand in for a row's space,
// so a pointer landing on one is aimed at that row — the container must not
// claim it, exactly as it must not claim a mounted row's.
describe('a deferred row placeholder', () => {
  it('is a block boundary, so the surface around it cannot claim its gestures', () => {
    const container = document.createElement('div')
    container.className = 'block-content'
    document.body.appendChild(container)
    render(<BlockLoadingPlaceholder />, {container})

    const inside = container.querySelector('.bullet-link')
    expect(inside).not.toBeNull()
    expect(ownsGestureTarget(container, inside)).toBe(false)
  })

  // Callers wrap their own chrome around that placeholder — padding, a header
  // skeleton, a whole group's reserved height — and a pointer landing on any of
  // it is still aimed at the row waiting there. Only the reserved slot spans
  // the lot, which is why the boundary is on it rather than on the placeholder.
  it('covers the caller\'s reserved area, not just the placeholder inside it', () => {
    vi.stubGlobal('IntersectionObserver', NoopIntersectionObserver)
    const container = document.createElement('div')
    container.className = 'block-content'
    document.body.appendChild(container)

    render(
      <LazyViewportMount
        cacheKey="row"
        blockId="row"
        estimatedHeightPx={96}
        overscanPx={0}
        renderPlaceholder={() => (
          <div className="caller-chrome py-2">
            <div className="header-skeleton" />
            <BlockLoadingPlaceholder reservedHeight={32} />
          </div>
        )}
      >
        <div>mounted</div>
      </LazyViewportMount>,
      {container},
    )

    // The caller's own chrome, outside the inner placeholder entirely.
    const chrome = container.querySelector('.header-skeleton')
    expect(chrome).not.toBeNull()
    expect(ownsGestureTarget(container, chrome)).toBe(false)
  })

  it('leaves the surface owning its own content', () => {
    // Fence: the container still owns everything that is not a placeholder, so
    // the assertion above is about the boundary rather than about `closest`
    // finding nothing.
    const container = document.createElement('div')
    container.className = 'block-content'
    const own = document.createElement('span')
    container.appendChild(own)
    document.body.appendChild(container)

    expect(ownsGestureTarget(container, own)).toBe(true)
  })
})
