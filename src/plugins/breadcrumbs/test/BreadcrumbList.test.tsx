import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Block } from '@/data/block'
import { BreadcrumbList } from '../BreadcrumbList.tsx'

const {innerLinkClick} = vi.hoisted(() => ({
  innerLinkClick: vi.fn(),
}))

vi.mock('@/components/BlockComponent.tsx', () => ({
  BlockComponent: ({blockId}: {blockId: string}) => (
    <a
      href={`#/inner/${blockId}`}
      data-testid="inner-link"
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        innerLinkClick(blockId)
      }}
    >
      Linked child
    </a>
  ),
}))

afterEach(() => {
  cleanup()
  innerLinkClick.mockClear()
})

describe('BreadcrumbList', () => {
  it('lets breadcrumb clicks win over links rendered inside the preview', () => {
    const parent = {id: 'parent-block'} as Block
    const onSelect = vi.fn()
    const surroundingClick = vi.fn()

    render(
      <div onClick={surroundingClick}>
        <BreadcrumbList
          parents={[parent]}
          workspaceId="workspace"
          overrides={{}}
          onSelect={onSelect}
        />
      </div>,
    )

    fireEvent.click(screen.getByTestId('inner-link'))

    expect(onSelect).toHaveBeenCalledExactlyOnceWith(parent)
    expect(innerLinkClick).not.toHaveBeenCalled()
    expect(surroundingClick).not.toHaveBeenCalled()
  })
})
