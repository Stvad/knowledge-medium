// @vitest-environment happy-dom
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Block } from '@/data/block'
import { BlockContextProvider } from '@/context/block'
import { LazyBlockEntry } from '../BlockEntry.tsx'

const mocks = vi.hoisted(() => ({
  openBlock: vi.fn(),
  useParents: vi.fn(() => [] as unknown[]),
  repo: {
    activeWorkspaceId: 'workspace',
    block: vi.fn((id: string) => ({id})),
  },
}))

vi.mock('@/context/repo.tsx', () => ({
  useRepo: () => mocks.repo,
}))

vi.mock('@/utils/navigation.ts', () => ({
  useBlockOpener: () => mocks.openBlock,
}))

// Partial: the breadcrumb list below pulls other hooks from this module, so
// only the ancestor fetch is stubbed — it's the thing under test.
vi.mock('@/hooks/block.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('@/hooks/block')>()),
  useParents: mocks.useParents,
}))

// Surfaces the ambient block context so tests can assert what the entry
// declares to the blocks it renders, not just what it renders.
vi.mock('@/components/BlockComponent.tsx', async () => {
  const {useBlockContext} = await import('@/context/block')
  return {
    BlockComponent: ({blockId}: {blockId: string}) => {
      const {scopeRootId} = useBlockContext()
      return (
        <span data-testid={`block-${blockId}`} data-scope-root={scopeRootId ?? ''}>
          {blockId}
        </span>
      )
    },
  }
})

vi.mock('@/components/util/LazyViewportMount.tsx', () => ({
  LazyViewportMount: ({children}: {children: ReactNode}) => <>{children}</>,
}))

afterEach(() => {
  cleanup()
  mocks.openBlock.mockClear()
  mocks.repo.block.mockClear()
  mocks.useParents.mockClear()
})

describe('BlockEntry breadcrumbs', () => {
  it('routes shift-clicks through the block opener', () => {
    const source = {id: 'source-block'} as Block
    const parent = {id: 'parent-block'} as Block

    render(
      <BlockContextProvider initialValue={{panelId: 'panel-a'}}>
        <LazyBlockEntry block={source} initialParents={[parent]} scopeId="test:source-block" />
      </BlockContextProvider>,
    )

    const event = createEvent.click(screen.getByTestId('block-parent-block'), {
      button: 0,
      shiftKey: true,
    })
    fireEvent(screen.getByTestId('block-parent-block'), event)

    expect(mocks.openBlock).toHaveBeenCalledOnce()
    const [forwardedEvent, ctx] = mocks.openBlock.mock.calls[0]
    expect(forwardedEvent.shiftKey).toBe(true)
    expect(ctx).toEqual({blockId: 'parent-block', workspaceId: 'workspace'})
  })
})

describe('BlockEntry prefetch hint', () => {
  // `undefined` and `[]` used to collapse to the same thing, so an entry the
  // caller's prefetch missed rendered with no breadcrumb, permanently. Both
  // real call sites pass `map.get(id)`, so a miss is `undefined` — the common
  // case, not a corner.
  it('fetches its own ancestors when none were prefetched', () => {
    const source = {id: 'source-block'} as Block

    render(
      <BlockContextProvider initialValue={{panelId: 'panel-a'}}>
        <LazyBlockEntry block={source} scopeId="test:no-prefetch" />
      </BlockContextProvider>,
    )

    expect(mocks.useParents).toHaveBeenCalled()
  })

  it('does NOT fetch when the caller prefetched, even an empty chain', () => {
    // `[]` is a real answer — a block with no ancestors — and must not be
    // mistaken for "I didn't look".
    const source = {id: 'source-block'} as Block

    render(
      <BlockContextProvider initialValue={{panelId: 'panel-a'}}>
        <LazyBlockEntry block={source} initialParents={[]} scopeId="test:empty-prefetch" />
      </BlockContextProvider>,
    )

    expect(mocks.useParents).not.toHaveBeenCalled()
  })
})

describe('BlockEntry structural-edit scope', () => {
  // The entry's shown block is the root of the only subtree this surface
  // renders, so it must declare itself the scope root. That single
  // override is what makes `resolveStructuralEditPolicy` treat `o` /
  // Enter / Tab here as scope-root gestures — without it the policy sees
  // an ordinary mid-tree block and `o` creates a sibling of the entry,
  // which lives outside the panel: present in the DB, nowhere to render.
  it('declares the shown block as the render-scope root for the blocks it renders', () => {
    const source = {id: 'source-block'} as Block
    const parent = {id: 'parent-block'} as Block

    render(
      <BlockContextProvider initialValue={{panelId: 'panel-a'}}>
        <LazyBlockEntry block={source} initialParents={[parent]} scopeId="test:source-block" />
      </BlockContextProvider>,
    )

    expect(screen.getByTestId('block-source-block').dataset.scopeRoot).toBe('source-block')
  })
})
