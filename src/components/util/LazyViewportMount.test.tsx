// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LazyViewportMount,
  __resetLazyMountCachesForTesting,
} from './LazyViewportMount'
import {
  __resetLazyMountRegistryForTesting,
  requestLazyMount,
} from './lazyMountRegistry'

class TestIntersectionObserver {
  static instances: TestIntersectionObserver[] = []

  readonly callback: IntersectionObserverCallback
  readonly options: IntersectionObserverInit | undefined
  readonly observe = vi.fn()
  readonly disconnect = vi.fn()

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback
    this.options = options
    TestIntersectionObserver.instances.push(this)
  }

  trigger(isIntersecting: boolean): void {
    this.callback(
      [{isIntersecting} as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    )
  }
}

const renderLazy = (
  cacheKey: string,
  options?: {container?: HTMLElement; overscanPx?: number; renderScopeId?: string},
) =>
  render(
    <LazyViewportMount
      cacheKey={cacheKey}
      blockId={cacheKey}
      renderScopeId={options?.renderScopeId}
      estimatedHeightPx={32}
      overscanPx={options?.overscanPx ?? 0}
      renderPlaceholder={({reservedHeight}) => (
        <div data-testid="placeholder" style={{minHeight: reservedHeight}} />
      )}
    >
      <div data-testid="child">Mounted content</div>
    </LazyViewportMount>,
    options?.container ? {container: options.container} : undefined,
  )

/** The slot a deferred row reserves, as the spatial-navigation walker queries
 *  it (`rowSlotIn` / `reservedRowBetween` both AND the two attributes). */
const reservedSlot = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-lazy-block-id][data-lazy-render-scope-id]')

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  TestIntersectionObserver.instances = []
  __resetLazyMountRegistryForTesting()
  __resetLazyMountCachesForTesting()
})

// The half of the deferred-row contract that lives here. The spatial-navigation
// walker decides whether a keyboard move would jump OVER a not-yet-mounted row
// by looking for these attributes; its own tests build the DOM by hand, so
// without these the producer and the consumer could drift apart silently and
// every suite would stay green.
//
// The other end of it — that `BlockChildren` SUPPLIES the scope — is pinned in
// `components/test/blockChildrenSlots.component.test.tsx`, against a real block
// tree, since neither half means anything alone.
describe('LazyViewportMount — the slot a deferred row reserves', () => {
  it('marks the placeholder with the block and the scope the row will have', () => {
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)

    renderLazy('block:deferred', {renderScopeId: 'panel:p1:top'})

    const slot = reservedSlot()
    expect(slot?.dataset.lazyBlockId).toBe('block:deferred')
    expect(slot?.dataset.lazyRenderScopeId).toBe('panel:p1:top')
  })

  it('drops the slot once the row mounts, so nothing reserves a place that is taken', async () => {
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)

    renderLazy('block:mounts', {renderScopeId: 'panel:p1:top'})
    expect(reservedSlot()).not.toBeNull()

    await act(async () => {
      TestIntersectionObserver.instances[0].trigger(true)
    })

    expect(screen.getByTestId('child')).toBeInTheDocument()
    expect(reservedSlot()).toBeNull()
  })

  // `LazyBacklinkItem` and the recents rows mint their scope INSIDE the wrapper,
  // so they can't name it out here and deliberately pass none. The walker must
  // then ignore the slot rather than attribute it to the surrounding row — which
  // it does by requiring both attributes, so this is the producer's half of it.
  it('leaves the slot anonymous when the caller cannot name the scope', () => {
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)

    renderLazy('block:anonymous')

    expect(reservedSlot()).toBeNull()
    expect(document.querySelector('[data-lazy-render-scope-id]')).toBeNull()
  })
})

describe('LazyViewportMount', () => {
  it('remounts a cache key immediately after it has mounted once', async () => {
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)

    const first = renderLazy('block:already-mounted')
    expect(screen.getByTestId('placeholder')).toBeInTheDocument()
    expect(screen.queryByTestId('child')).not.toBeInTheDocument()

    await act(async () => {
      TestIntersectionObserver.instances[0].trigger(true)
    })
    expect(screen.getByTestId('child')).toBeInTheDocument()

    first.unmount()
    TestIntersectionObserver.instances = []

    renderLazy('block:already-mounted')

    expect(screen.getByTestId('child')).toBeInTheDocument()
    expect(screen.queryByTestId('placeholder')).not.toBeInTheDocument()
    expect(TestIntersectionObserver.instances).toHaveLength(0)
  })

  // `rootMargin` expands the ROOT's rect only — a scrolling ancestor in
  // between clips the target unexpanded. Rooted at the viewport (the
  // default), the overscan bought nothing inside a scrolling panel and rows
  // mounted only once literally on screen.
  it('roots the observer at the scrolling ancestor so the overscan applies', () => {
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)

    const scroller = document.createElement('div')
    scroller.style.overflowY = 'auto'
    document.body.appendChild(scroller)
    const host = document.createElement('div')
    scroller.appendChild(host)

    renderLazy('block:in-scroller', {container: host, overscanPx: 600})

    // Asymmetric: the caller's overscan governs DOWNWARD only, where a
    // keystroke needs it; upward is capped to keep the at-rest mounted set
    // (and the layout shift above the fold) down.
    expect(TestIntersectionObserver.instances[0].options).toMatchObject({
      root: scroller,
      rootMargin: '200px 0px 600px 0px',
    })
  })

  it('mounts a pending row on request, so focus can land on an off-screen block', async () => {
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)

    renderLazy('block:off-screen')
    expect(screen.getByTestId('placeholder')).toBeInTheDocument()

    await act(async () => {
      requestLazyMount('block:off-screen')
    })

    expect(screen.getByTestId('child')).toBeInTheDocument()
  })

  // The same block renders in every panel/embed/recents row showing it, all
  // under one cache key. Mounting only one of them would strand the others as
  // placeholders their effects will never re-register — and the stranded one
  // may be exactly the copy the focused location refers to.
  it('mounts every pending row sharing a cache key', async () => {
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)

    renderLazy('block:two-copies')
    renderLazy('block:two-copies')
    expect(screen.getAllByTestId('placeholder')).toHaveLength(2)

    await act(async () => {
      requestLazyMount('block:two-copies')
    })

    expect(screen.getAllByTestId('child')).toHaveLength(2)
    expect(screen.queryByTestId('placeholder')).not.toBeInTheDocument()
  })

  // A request routinely arrives before the row exists: mounting a parent
  // renders no children until its childIds handle resolves, so focus can move
  // onto the first child a commit or two before that child registers. An
  // edge-triggered request would be dropped there.
  it('mounts a row that registers after the request, until the want is withdrawn', async () => {
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)

    const withdraw = requestLazyMount('block:not-yet-rendered')
    renderLazy('block:not-yet-rendered')
    expect(screen.getByTestId('child')).toBeInTheDocument()

    cleanup()
    __resetLazyMountCachesForTesting()
    withdraw()

    renderLazy('block:not-yet-rendered')
    expect(screen.getByTestId('placeholder')).toBeInTheDocument()
    expect(screen.queryByTestId('child')).not.toBeInTheDocument()
  })

  // Two panels can hold focus on the same block. If wants were a flag rather
  // than a count, the first panel to move on would cancel the second's, and
  // the second's row would stay deferred once its placeholder registered.
  it('keeps a want alive while another requester still holds it', () => {
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)

    const withdrawFirst = requestLazyMount('block:wanted-twice')
    requestLazyMount('block:wanted-twice')
    withdrawFirst()

    renderLazy('block:wanted-twice')
    expect(screen.getByTestId('child')).toBeInTheDocument()
  })

  // ...and a double cleanup must not spend the OTHER requester's want. Effect
  // cleanups are supposed to run once, so this is defence in depth — but the
  // failure it prevents is silent and remote: the second panel's focused row
  // stays a placeholder, so its highlight, its DOM focus and normal mode all
  // go quiet with nothing pointing back here.
  it('ignores a withdrawal called twice', () => {
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)

    const withdrawFirst = requestLazyMount('block:withdrawn-twice')
    requestLazyMount('block:withdrawn-twice')
    withdrawFirst()
    withdrawFirst()

    renderLazy('block:withdrawn-twice')
    expect(screen.getByTestId('child')).toBeInTheDocument()
  })
})
