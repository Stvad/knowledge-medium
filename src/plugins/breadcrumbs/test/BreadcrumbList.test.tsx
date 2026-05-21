import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import type { MouseEvent } from 'react'
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

  it('leaves modified clicks to native link behavior by default', () => {
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

    const innerLink = screen.getByTestId('inner-link')
    const event = createEvent.click(innerLink, {button: 0, shiftKey: true})
    fireEvent(innerLink, event)

    expect(onSelect).not.toHaveBeenCalled()
    expect(innerLinkClick).not.toHaveBeenCalled()
    expect(surroundingClick).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('delegates unhandled clicks to an owner-provided link policy', () => {
    const parent = {id: 'parent-block'} as Block
    const onSelect = vi.fn()
    const onLinkClick = vi.fn((event: MouseEvent, clickedParent: Block) => {
      expect(clickedParent).toBe(parent)
      event.preventDefault()
    })

    render(
      <BreadcrumbList
        parents={[parent]}
        workspaceId="workspace"
        overrides={{}}
        onSelect={onSelect}
        onLinkClick={onLinkClick}
      />,
    )

    const innerLink = screen.getByTestId('inner-link')
    const event = createEvent.click(innerLink, {button: 0, shiftKey: true})
    fireEvent(innerLink, event)

    expect(onSelect).not.toHaveBeenCalled()
    expect(innerLinkClick).not.toHaveBeenCalled()
    expect(onLinkClick).toHaveBeenCalledOnce()
    expect(onLinkClick.mock.calls[0][0].shiftKey).toBe(true)
    expect(event.defaultPrevented).toBe(true)
  })
})
