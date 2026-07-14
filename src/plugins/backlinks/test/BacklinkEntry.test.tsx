// @vitest-environment jsdom
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Block } from '@/data/block'
import { BlockContextProvider } from '@/context/block'
import { EMPTY_RENDER_VISIBILITY_POLICY } from '@/utils/renderVisibility'
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

vi.mock('@/hooks/block.js', () => ({
  useParents: (block: Block) => {
    if (block.id === 'parent-a') return [mocks.repo.block('root')]
    if (block.id === 'parent-b') return [mocks.repo.block('root'), mocks.repo.block('parent-a')]
    return []
  },
}))

vi.mock('@/components/BlockComponent.tsx', async () => {
  const {useBlockContext} = await vi.importActual<typeof import('@/context/block')>('@/context/block')
  return {
    BlockComponent: ({blockId}: {blockId: string}) => {
      const context = useBlockContext()
      return (
        <span
          data-testid={`block-${blockId}`}
          data-force-open={(context.renderVisibilityPolicy.forceOpenBlockIds ?? []).join(',')}
        >
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
      <BlockContextProvider initialValue={{
        panelId: 'panel-a',
        renderVisibilityPolicy: EMPTY_RENDER_VISIBILITY_POLICY,
      }}>
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

  it('force-opens the promoted ancestor path back to the backlink source', () => {
    const source = {id: 'source-block'} as Block
    const root = {id: 'root'} as Block
    const parentA = {id: 'parent-a'} as Block
    const parentB = {id: 'parent-b'} as Block

    render(
      <BlockContextProvider initialValue={{
        panelId: 'panel-a',
        renderVisibilityPolicy: EMPTY_RENDER_VISIBILITY_POLICY,
      }}>
        <LazyBacklinkItem
          block={source}
          initialParents={[root, parentA, parentB]}
          scopeId="test:source-block"
        />
      </BlockContextProvider>,
    )

    fireEvent.click(screen.getByTestId('block-parent-a'))

    expect(screen.getByTestId('block-parent-a')).toHaveAttribute(
      'data-force-open',
      'parent-a,parent-b',
    )
  })
})
