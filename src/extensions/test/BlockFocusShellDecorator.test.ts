// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { shouldScrollFocusedBlockIntoView } from '@/extensions/BlockFocusShellDecorator.js'

const testRect = (top: number, height: number): DOMRect =>
  ({
    top,
    bottom: top + height,
    left: 0,
    right: 100,
    width: 100,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect

const elementWithRect = (rect: DOMRect): HTMLElement => {
  const element = document.createElement('div')
  element.style.fontSize = '16px'
  element.style.lineHeight = '20px'
  element.getBoundingClientRect = () => rect
  return element
}

const scrollContainerWithRect = (rect: DOMRect): HTMLElement => {
  const element = elementWithRect(rect)
  element.style.overflowY = 'auto'
  return element
}

describe('shouldScrollFocusedBlockIntoView', () => {
  it('does not scroll to the content row when a long focused row already spans the viewport', () => {
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight
    const focusedRow = elementWithRect(testRect(-240, viewportHeight + 600))
    const content = elementWithRect(testRect(-240, 24))

    expect(shouldScrollFocusedBlockIntoView(focusedRow, content)).toBe(false)
  })

  it('does not scroll when one line of a long focused row remains visible', () => {
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight
    const focusedRowHeight = viewportHeight + 240
    const focusedRow = elementWithRect(testRect(-(focusedRowHeight - 20), focusedRowHeight))
    const content = elementWithRect(testRect(-(focusedRowHeight - 20), 24))

    expect(shouldScrollFocusedBlockIntoView(focusedRow, content)).toBe(false)
  })

  it('scrolls when less than one line of a long focused row is visible inside the scroll container', () => {
    const scrollContainer = scrollContainerWithRect(testRect(100, 600))
    const focusedRowHeight = window.innerHeight + 600
    const focusedRowTop = 108 - focusedRowHeight
    const focusedRow = elementWithRect(testRect(focusedRowTop, focusedRowHeight))
    const content = elementWithRect(testRect(focusedRowTop, 24))
    scrollContainer.append(focusedRow)
    focusedRow.append(content)

    expect(shouldScrollFocusedBlockIntoView(focusedRow, content)).toBe(true)
  })

  it('does not scroll when one line of properties remains visible inside the scroll container', () => {
    const scrollContainer = scrollContainerWithRect(testRect(100, 600))
    const focusedRowHeight = window.innerHeight + 600
    const focusedRowTop = 120 - focusedRowHeight
    const focusedRow = elementWithRect(testRect(focusedRowTop, focusedRowHeight))
    const content = elementWithRect(testRect(focusedRowTop, 24))
    scrollContainer.append(focusedRow)
    focusedRow.append(content)

    expect(shouldScrollFocusedBlockIntoView(focusedRow, content)).toBe(false)
  })

  it('scrolls when content is inside the window but above the scroll container', () => {
    const scrollContainer = scrollContainerWithRect(testRect(100, 600))
    const focusedRow = elementWithRect(testRect(60, 24))
    const content = elementWithRect(testRect(60, 24))
    scrollContainer.append(focusedRow)
    focusedRow.append(content)

    expect(shouldScrollFocusedBlockIntoView(focusedRow, content)).toBe(true)
  })

  it('scrolls when less than one line of a long focused row remains visible', () => {
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight
    const focusedRowHeight = viewportHeight + 240
    const focusedRow = elementWithRect(testRect(-(focusedRowHeight - 8), focusedRowHeight))
    const content = elementWithRect(testRect(-(focusedRowHeight - 8), 24))

    expect(shouldScrollFocusedBlockIntoView(focusedRow, content)).toBe(true)
  })

  it('keeps scrolling when both the content and focused row are off-screen', () => {
    const focusedRow = elementWithRect(testRect(-240, 120))
    const content = elementWithRect(testRect(-240, 24))

    expect(shouldScrollFocusedBlockIntoView(focusedRow, content)).toBe(true)
  })

  it('scrolls when only descendants inside the block shell are visible', () => {
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight
    const shell = elementWithRect(testRect(-240, viewportHeight + 600))
    const focusedRow = elementWithRect(testRect(-80, 40))
    const content = elementWithRect(testRect(-80, 24))
    const visibleChild = elementWithRect(testRect(40, 24))
    shell.append(focusedRow, visibleChild)
    focusedRow.append(content)

    expect(shouldScrollFocusedBlockIntoView(focusedRow, content)).toBe(true)
  })

  it('does not scroll when the content row itself is visible', () => {
    const focusedRow = elementWithRect(testRect(40, 120))
    const content = elementWithRect(testRect(40, 24))

    expect(shouldScrollFocusedBlockIntoView(focusedRow, content)).toBe(false)
  })
})
