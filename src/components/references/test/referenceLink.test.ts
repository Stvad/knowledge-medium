// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import type { MouseEvent } from 'react'
import { rawContentOwnsClick } from '../ReferenceLink'

// A reference wraps raw content in a navigating link; rich content owns its own
// clicks (so they don't ALSO navigate). This guards which targets are treated as
// rich: media images + interactive content (the video player's controls / iframe),
// but NOT plain text.
const clickOn = (el: Element): MouseEvent =>
  ({ target: el } as unknown as MouseEvent)

describe('rawContentOwnsClick — a reference defers to rich raw content', () => {
  it('treats a clicked image (media reference) as owning its click', () => {
    expect(rawContentOwnsClick(clickOn(document.createElement('img')))).toBe(true)
  })

  it('treats interactive content (the video player controls / a button) as owning its click', () => {
    const video = document.createElement('video')
    video.setAttribute('controls', '')
    expect(rawContentOwnsClick(clickOn(video))).toBe(true)
    expect(rawContentOwnsClick(clickOn(document.createElement('button')))).toBe(true)
    const iframe = document.createElement('iframe')
    expect(rawContentOwnsClick(clickOn(iframe))).toBe(true)
  })

  it('lets plain text content navigate (the link owns it)', () => {
    const span = document.createElement('span')
    span.textContent = 'hello'
    expect(rawContentOwnsClick(clickOn(span))).toBe(false)
  })
})
