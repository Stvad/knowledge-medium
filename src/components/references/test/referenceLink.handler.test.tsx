// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, createEvent, fireEvent, render } from '@testing-library/react'
import type { Block } from '@/data/block'

// Direct coverage of the ReferenceLink onClick WIRING (not just the pure
// classifier). Both prior click bugs lived in this handler, and the classifier
// unit test wouldn't catch a regression that mis-wires the owner→action mapping
// (e.g. flipping the 'anchor' branch to preventDefault).
const openBlock = vi.fn()
vi.mock('@/context/repo', () => ({ useRepo: () => ({ activeWorkspaceId: 'ws' }) }))
vi.mock('@/hooks/block', () => ({ useWorkspaceId: () => 'ws' }))
vi.mock('@/utils/navigation', () => ({ useOpenBlock: () => openBlock }))

const { ReferenceLink } = await import('../ReferenceLink')

const block = { id: 'target' } as Block
const clickAndGetEvent = (el: Element) => {
  const event = createEvent.click(el, { bubbles: true, cancelable: true })
  fireEvent(el, event)
  return event
}

afterEach(() => {
  cleanup()
  openBlock.mockClear()
})

describe('ReferenceLink onClick wiring', () => {
  it('plain text → navigates (openBlock called), no preventDefault', () => {
    const { getByText } = render(<ReferenceLink block={block}><span>hello</span></ReferenceLink>)
    const event = clickAndGetEvent(getByText('hello'))
    expect(openBlock).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(false)
  })

  it('a nested link → does NOT navigate and does NOT preventDefault (inner link navigates natively)', () => {
    const { getByText } = render(
      <ReferenceLink block={block}><a href="https://example.com">link</a></ReferenceLink>,
    )
    const event = clickAndGetEvent(getByText('link'))
    expect(openBlock).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('rich content (image) → does NOT navigate but DOES preventDefault (content owns it)', () => {
    const { container } = render(<ReferenceLink block={block}><img alt="" src="x"/></ReferenceLink>)
    const event = clickAndGetEvent(container.querySelector('img')!)
    expect(openBlock).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })
})
