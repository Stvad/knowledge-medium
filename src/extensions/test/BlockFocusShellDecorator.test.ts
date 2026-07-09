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

describe('shouldScrollFocusedBlockIntoView', () => {
  it('does not scroll to the content row when a long block shell already spans the viewport', () => {
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight
    const shell = elementWithRect(testRect(-240, viewportHeight + 600))
    const content = elementWithRect(testRect(-240, 24))

    expect(shouldScrollFocusedBlockIntoView(shell, content)).toBe(false)
  })

  it('scrolls when only a one-line sliver of a long block shell remains visible', () => {
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight
    const shellHeight = viewportHeight + 240
    const shell = elementWithRect(testRect(-(shellHeight - 20), shellHeight))
    const content = elementWithRect(testRect(-(shellHeight - 20), 24))

    expect(shouldScrollFocusedBlockIntoView(shell, content)).toBe(true)
  })

  it('keeps scrolling when both the content row and block shell are off-screen', () => {
    const shell = elementWithRect(testRect(-240, 120))
    const content = elementWithRect(testRect(-240, 24))

    expect(shouldScrollFocusedBlockIntoView(shell, content)).toBe(true)
  })

  it('does not scroll when the content row itself is visible', () => {
    const shell = elementWithRect(testRect(40, 120))
    const content = elementWithRect(testRect(40, 24))

    expect(shouldScrollFocusedBlockIntoView(shell, content)).toBe(false)
  })
})
