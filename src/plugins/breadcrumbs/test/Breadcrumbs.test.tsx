// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Block } from '@/data/block'
import { BlockContextProvider } from '@/context/block'
import { Breadcrumbs } from '../Breadcrumbs.tsx'

const mocks = vi.hoisted(() => ({
  openBlock: vi.fn(),
  parent: {id: 'parent-block'} as Block,
  repo: {activeWorkspaceId: 'workspace'} as {activeWorkspaceId: string},
}))

vi.mock('@/context/repo.tsx', () => ({
  useRepo: () => mocks.repo,
}))

vi.mock('@/hooks/block.ts', () => ({
  useParents: () => [mocks.parent],
}))

vi.mock('@/utils/navigation.ts', () => ({
  useBlockOpener: () => mocks.openBlock,
}))

vi.mock('@/components/BlockComponent.tsx', () => ({
  BlockComponent: ({blockId}: {blockId: string}) => (
    <span data-testid={`breadcrumb-${blockId}`}>{blockId}</span>
  ),
}))

afterEach(() => {
  cleanup()
  mocks.openBlock.mockClear()
})

describe('Breadcrumbs', () => {
  it('routes breadcrumb clicks through the block opener', () => {
    render(
      <BlockContextProvider initialValue={{panelId: 'panel-a'}}>
        <Breadcrumbs block={{id: 'child-block'} as Block}/>
      </BlockContextProvider>,
    )

    fireEvent.click(screen.getByTestId('breadcrumb-parent-block'))

    expect(mocks.openBlock).toHaveBeenCalledOnce()
    const [, ctx] = mocks.openBlock.mock.calls[0]
    expect(ctx).toEqual({blockId: 'parent-block', workspaceId: 'workspace'})
  })
})
