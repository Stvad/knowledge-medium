// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import type { MouseEvent } from 'react'
import { rawContentOwnsClick } from '../ReferenceLink'

// A reference renders its raw content INSIDE its own `<a href>`. The guard must
// distinguish a click on rich content (which owns it) from a click on plain text
// (which should navigate) — WITHOUT the link's own anchor counting as "rich".
// So every case nests the clicked node inside a real `<a href>` (the currentTarget).
const link = (): HTMLAnchorElement => {
  const a = document.createElement('a')
  a.href = '#target'
  return a
}
const clickOn = (target: Element, currentTarget: Element): MouseEvent =>
  ({ target, currentTarget } as unknown as MouseEvent)

describe('rawContentOwnsClick — a reference defers to rich raw content, never its own link', () => {
  it('a plain-text span inside the link navigates (the link owns it)', () => {
    const a = link()
    const span = document.createElement('span')
    span.textContent = 'hello'
    a.appendChild(span)
    expect(rawContentOwnsClick(clickOn(span, a))).toBe(false)
  })

  it('a click on the reference link element itself navigates', () => {
    const a = link()
    expect(rawContentOwnsClick(clickOn(a, a))).toBe(false)
  })

  it('a media image inside the link owns its click (lightbox, not navigate)', () => {
    const a = link()
    const img = document.createElement('img')
    a.appendChild(img)
    expect(rawContentOwnsClick(clickOn(img, a))).toBe(true)
  })

  it('the video player (video[controls] / iframe) and a button own their clicks', () => {
    const a = link()
    const video = document.createElement('video')
    video.setAttribute('controls', '')
    a.appendChild(video)
    const iframe = document.createElement('iframe')
    a.appendChild(iframe)
    const button = document.createElement('button')
    a.appendChild(button)
    expect(rawContentOwnsClick(clickOn(video, a))).toBe(true)
    expect(rawContentOwnsClick(clickOn(iframe, a))).toBe(true)
    expect(rawContentOwnsClick(clickOn(button, a))).toBe(true)
  })

  it('a nested reference/link inside the content owns its click (the inner link navigates, not the outer)', () => {
    const a = link()
    const inner = document.createElement('a')
    inner.href = '#inner'
    const innerText = document.createElement('span')
    inner.appendChild(innerText)
    a.appendChild(inner)
    expect(rawContentOwnsClick(clickOn(innerText, a))).toBe(true)
  })
})
