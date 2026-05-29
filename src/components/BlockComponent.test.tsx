// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
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
  it('keeps hidden property children behind a local reveal toggle', () => {
    vi.mocked(useChildIds).mockImplementation(((_block: Block, options?: {includeHiddenPropertyChildren?: boolean}) =>
      options?.includeHiddenPropertyChildren === true
        ? ['visible-child', 'hidden-field']
        : ['visible-child']) as typeof useChildIds)

    render(<BlockChildren block={{id: 'parent'} as Block} />)

    expect(screen.getAllByTestId('lazy-block').map(el => el.textContent)).toEqual(['visible-child'])

    fireEvent.click(screen.getByRole('button', {name: 'Show hidden fields (1)'}))
    expect(screen.getAllByTestId('lazy-block').map(el => el.textContent)).toEqual(['visible-child', 'hidden-field'])

    fireEvent.click(screen.getByRole('button', {name: 'Hide hidden fields'}))
    expect(screen.getAllByTestId('lazy-block').map(el => el.textContent)).toEqual(['visible-child'])
  })
})
