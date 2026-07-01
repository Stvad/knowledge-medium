// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LazyViewportMount } from './LazyViewportMount'

class TestIntersectionObserver {
  static instances: TestIntersectionObserver[] = []

  readonly callback: IntersectionObserverCallback
  readonly observe = vi.fn()
  readonly disconnect = vi.fn()

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
    TestIntersectionObserver.instances.push(this)
  }

  trigger(isIntersecting: boolean): void {
    this.callback(
      [{isIntersecting} as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    )
  }
}

const renderLazy = (cacheKey: string) =>
  render(
    <LazyViewportMount
      cacheKey={cacheKey}
      estimatedHeightPx={32}
      overscanPx={0}
      renderPlaceholder={({reservedHeight}) => (
        <div data-testid="placeholder" style={{minHeight: reservedHeight}} />
      )}
    >
      <div data-testid="child">Mounted content</div>
    </LazyViewportMount>,
  )

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  TestIntersectionObserver.instances = []
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
})
