// @vitest-environment happy-dom
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Block } from '@/data/block'
import { BlockContextProvider } from '@/context/block'
import { LazyBacklinkItem } from '../BacklinkEntry.tsx'

const mocks = vi.hoisted(() => ({
  openBlock: vi.fn(),
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
})

describe('BacklinkEntry breadcrumbs', () => {
  it('routes shift-clicks through the block opener', () => {
    const source = {id: 'source-block'} as Block
    const parent = {id: 'parent-block'} as Block

    render(
      <BlockContextProvider initialValue={{panelId: 'panel-a'}}>
        <LazyBacklinkItem block={source} initialParents={[parent]} scopeId="test:source-block" />
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

describe('BacklinkEntry structural-edit scope', () => {
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
        <LazyBacklinkItem block={source} initialParents={[parent]} scopeId="test:source-block" />
      </BlockContextProvider>,
    )

    expect(screen.getByTestId('block-source-block').dataset.scopeRoot).toBe('source-block')
  })
})
