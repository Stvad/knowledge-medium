import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Block } from '@/data/block'
import { BlockContextProvider } from '@/context/block'
import { BreadcrumbList } from '../BreadcrumbList.tsx'

const {innerLinkClick, navigate} = vi.hoisted(() => ({
  innerLinkClick: vi.fn(),
  navigate: vi.fn(),
}))

vi.mock('@/utils/navigation.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('@/utils/navigation.ts')>()
  return {
    ...actual,
    useNavigate: () => navigate,
  }
})

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
  navigate.mockClear()
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

  it('routes shift-clicks through app stack navigation', () => {
    const parent = {id: 'parent-block'} as Block
    const onSelect = vi.fn()
    const surroundingClick = vi.fn()

    render(
      <BlockContextProvider initialValue={{panelId: 'panel-a'}}>
        <div onClick={surroundingClick}>
          <BreadcrumbList
            parents={[parent]}
            workspaceId="workspace"
            overrides={{}}
            onSelect={onSelect}
          />
        </div>
      </BlockContextProvider>,
    )

    const innerLink = screen.getByTestId('inner-link')
    const event = createEvent.click(innerLink, {button: 0, shiftKey: true})
    fireEvent(innerLink, event)

    expect(onSelect).not.toHaveBeenCalled()
    expect(innerLinkClick).not.toHaveBeenCalled()
    expect(surroundingClick).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledExactlyOnceWith({
      blockId: 'parent-block',
      workspaceId: 'workspace',
      target: 'sidebar-stack',
      sourcePanelId: 'panel-a',
    })
    expect(event.defaultPrevented).toBe(true)
  })
})
