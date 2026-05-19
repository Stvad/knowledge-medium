// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Block } from '@/data/block'
import { BlockContextProvider } from '@/context/block'
import { Breadcrumbs } from '../Breadcrumbs.tsx'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
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
  useNavigate: () => mocks.navigate,
}))

vi.mock('@/components/BlockComponent.tsx', () => ({
  BlockComponent: ({blockId}: {blockId: string}) => (
    <span data-testid={`breadcrumb-${blockId}`}>{blockId}</span>
  ),
}))

afterEach(() => {
  cleanup()
  mocks.navigate.mockClear()
})

describe('Breadcrumbs', () => {
  it('navigates the current panel when a panel breadcrumb is clicked', () => {
    render(
      <BlockContextProvider initialValue={{panelId: 'panel-a'}}>
        <Breadcrumbs block={{id: 'child-block'} as Block}/>
      </BlockContextProvider>,
    )

    fireEvent.click(screen.getByTestId('breadcrumb-parent-block'))

    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({
      blockId: 'parent-block',
      workspaceId: 'workspace',
      target: 'panel',
      panelId: 'panel-a',
    })
  })
})
