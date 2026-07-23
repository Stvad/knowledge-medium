// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { cleanup, render } from '@testing-library/react'
import type { Block } from '@/data/block'

interface FakeProjectionOptions {
  repo: unknown
  workspaceId: string
  layoutSessionBlock: Block
}

const {instances, callOrder, FakeProjection} = vi.hoisted(() => {
  interface Options {
    repo: unknown
    workspaceId: string
    layoutSessionBlock: unknown
  }

  class FakeProjection {
    readonly options: Options
    readonly subscribers: Array<() => void> = []
    started = false
    disposed = false
    unsubscribed = false

    constructor(options: Options) {
      this.options = options
      instances.push(this)
    }

    subscribe(cb: () => void): () => void {
      // Shared (not per-instance) so the assertion pins the ACTUAL call
      // order the hook issues them in, not just each method's own timing.
      callOrder.push('subscribe')
      this.subscribers.push(cb)
      return () => { this.unsubscribed = true }
    }

    start(): Promise<void> {
      callOrder.push('start')
      this.started = true
      return Promise.resolve()
    }

    dispose(): void {
      this.disposed = true
    }
  }

  const instances: FakeProjection[] = []
  const callOrder: string[] = []
  return {instances, callOrder, FakeProjection}
})

vi.mock('@/utils/panelLayoutProjection.js', () => ({
  PanelLayoutProjection: FakeProjection,
}))

import { usePanelLayoutProjection } from '@/hooks/usePanelLayoutProjection.js'
import { LayoutRootContext, type LayoutRootContextValue } from '@/components/renderer/layoutRootContext.js'

const ROOT_ID = 'layout-session-1'
const fakeRepo = {activeWorkspaceId: 'ws-1' as string | null}
const rootBlock = {id: ROOT_ID, repo: fakeRepo} as unknown as Block
const otherBlock = {id: 'other-block', repo: fakeRepo} as unknown as Block

const Probe = ({block}: {block: Block}) => {
  usePanelLayoutProjection(block)
  return null
}

const renderProbe = (
  block: Block,
  context: LayoutRootContextValue | null,
  {strict = false}: {strict?: boolean} = {},
) => {
  const tree = (
    <LayoutRootContext.Provider value={context}>
      <Probe block={block}/>
    </LayoutRootContext.Provider>
  )
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree)
}

beforeEach(() => {
  instances.length = 0
  callOrder.length = 0
  fakeRepo.activeWorkspaceId = 'ws-1'
})

afterEach(() => cleanup())

describe('usePanelLayoutProjection', () => {
  it('no-ops without a LayoutRootContext', () => {
    renderProbe(rootBlock, null)
    expect(instances).toHaveLength(0)
  })

  it('no-ops for a block that is not the layout root (stray layoutBoundary mounts)', () => {
    renderProbe(otherBlock, {rootBlockId: ROOT_ID, onLayoutHashChanged: vi.fn()})
    expect(instances).toHaveLength(0)
  })

  it('no-ops when no workspace is active yet', () => {
    fakeRepo.activeWorkspaceId = null
    renderProbe(rootBlock, {rootBlockId: ROOT_ID, onLayoutHashChanged: vi.fn()})
    expect(instances).toHaveLength(0)
  })

  it('constructs, subscribes, starts, and calls onLayoutHashChanged for the root block', async () => {
    const onLayoutHashChanged = vi.fn()
    const view = renderProbe(rootBlock, {rootBlockId: ROOT_ID, onLayoutHashChanged})

    expect(instances).toHaveLength(1)
    const projection = instances[0]
    expect(projection.options as FakeProjectionOptions).toEqual({
      repo: fakeRepo,
      workspaceId: 'ws-1',
      layoutSessionBlock: rootBlock,
    })
    expect(projection.started).toBe(true)
    // subscribe() MUST precede start(): start() can resolve as early as the
    // same microtask, and any change it observes before a listener is
    // attached is lost — so subscribing after starting would silently drop
    // the earliest projection notifications.
    expect(callOrder).toEqual(['subscribe', 'start'])
    // start() resolving fires the initial hash sync.
    await vi.waitFor(() => expect(onLayoutHashChanged).toHaveBeenCalledTimes(1))

    // Projection change notifications flow to the same callback.
    projection.subscribers.forEach(cb => cb())
    expect(onLayoutHashChanged).toHaveBeenCalledTimes(2)

    view.unmount()
    expect(projection.unsubscribed).toBe(true)
    expect(projection.disposed).toBe(true)
  })

  it('survives a StrictMode double-mount without leaking the first projection', async () => {
    const onLayoutHashChanged = vi.fn()
    const view = renderProbe(
      rootBlock,
      {rootBlockId: ROOT_ID, onLayoutHashChanged},
      {strict: true},
    )

    // mount → cleanup → mount: two instances, only the second stays live.
    expect(instances).toHaveLength(2)
    const [first, second] = instances
    expect(first.disposed).toBe(true)
    expect(second.disposed).toBe(false)

    // The torn-down first instance's late start() resolution must NOT fire
    // the callback — only the live one syncs the hash.
    await vi.waitFor(() => expect(onLayoutHashChanged).toHaveBeenCalled())
    expect(onLayoutHashChanged).toHaveBeenCalledTimes(1)

    view.unmount()
    expect(second.disposed).toBe(true)
  })
})
