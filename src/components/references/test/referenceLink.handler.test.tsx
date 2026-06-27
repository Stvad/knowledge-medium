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
const clickAndGetEvent = (el: Element, init: MouseEventInit = {}) => {
  const event = createEvent.click(el, { bubbles: true, cancelable: true, ...init })
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

  it('a click that finished selecting text inside the reference → does NOT navigate (keeps the selection)', () => {
    const { getByText } = render(<ReferenceLink block={block}><span>hello</span></ReferenceLink>)
    const span = getByText('hello')
    // An active (non-collapsed) selection anchored inside the reference — what a
    // drag-select / double-click leaves behind by the time `click` fires.
    const getSelection = vi.spyOn(window, 'getSelection').mockReturnValue(
      { isCollapsed: false, anchorNode: span } as unknown as Selection,
    )
    try {
      clickAndGetEvent(span)
    } finally {
      getSelection.mockRestore()
    }
    expect(openBlock).not.toHaveBeenCalled()
  })

  // Regression: a cmd/ctrl-click on rich content must STILL be suppressed. The
  // rich element's own handler (e.g. an image lightbox) already fired on the way
  // up; if the reference also reached the opener, the modifier would passthrough
  // to the native href and open the target in a new tab — a double action.
  it('modified click on rich content (image) → still suppressed, opener NOT reached', () => {
    const { container } = render(<ReferenceLink block={block}><img alt="" src="x"/></ReferenceLink>)
    const event = clickAndGetEvent(container.querySelector('img')!, { metaKey: true })
    expect(openBlock).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  // The opener is still reached for a modified click on PLAIN content, so
  // cmd/shift-clicking the link's text opens the target out-of-place (the opener
  // resolves the modifier itself).
  it('modified click on plain text → reaches the opener', () => {
    const { getByText } = render(<ReferenceLink block={block}><span>hello</span></ReferenceLink>)
    clickAndGetEvent(getByText('hello'), { metaKey: true })
    expect(openBlock).toHaveBeenCalledTimes(1)
  })
})
