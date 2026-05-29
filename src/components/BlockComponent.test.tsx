// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Block } from '@/data/block'
import { useChildIds } from '@/hooks/block.js'
import { BlockChildren } from './BlockComponent'

vi.mock('@/hooks/block.js', () => ({
  useChildIds: vi.fn(),
}))

vi.mock('./LazyBlockComponent.tsx', () => ({
  LazyBlockComponent: ({blockId}: {blockId: string}) => (
    <div data-testid="lazy-block">{blockId}</div>
  ),
}))

describe('BlockChildren', () => {
  it('renders hidden property children only when the caller asks for them', () => {
    vi.mocked(useChildIds).mockImplementation(((_block: Block, options?: {includeHiddenPropertyChildren?: boolean}) =>
      options?.includeHiddenPropertyChildren === true
        ? ['visible-child', 'hidden-field']
        : ['visible-child']) as typeof useChildIds)

    const view = render(<BlockChildren block={{id: 'parent'} as Block} />)

    expect(screen.getAllByTestId('lazy-block').map(el => el.textContent)).toEqual(['visible-child'])
    expect(screen.queryByRole('button')).toBeNull()

    view.rerender(<BlockChildren block={{id: 'parent'} as Block} includeHiddenPropertyChildren />)
    expect(screen.getAllByTestId('lazy-block').map(el => el.textContent)).toEqual(['visible-child', 'hidden-field'])
  })
})
