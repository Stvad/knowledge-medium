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

vi.mock('@/components/BlockComponent.tsx', () => ({
  BlockComponent: ({blockId}: {blockId: string}) => (
    <span data-testid={`block-${blockId}`}>{blockId}</span>
  ),
}))

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
        <LazyBacklinkItem block={source} initialParents={[parent]} />
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
