// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import type { MouseEvent } from 'react'
import { classifyLinkInteraction } from '../linkInteraction'

// A reference renders its raw content INSIDE its own `<a href>`. Classify a click
// as: 'anchor' (a nested link — navigates natively, the reference does nothing),
// 'rich' (image/video/button — handled itself, the reference suppresses its nav),
// or null (plain text — the reference navigates). Every case nests the clicked
// node inside a real `<a href>` (the currentTarget), so the link's OWN anchor
// never counts.
const link = (): HTMLAnchorElement => {
  const a = document.createElement('a')
  a.href = '#target'
  return a
}
const append = <T extends Element>(parent: Element, child: T): T => {
  parent.appendChild(child)
  return child
}
const clickOn = (target: Node, currentTarget: Element): MouseEvent =>
  ({ target, currentTarget } as unknown as MouseEvent)

describe('classifyLinkInteraction', () => {
  it('plain text / the link element itself → null (the reference navigates)', () => {
    const a = link()
    const span = append(a, document.createElement('span'))
    span.textContent = 'hello'
    expect(classifyLinkInteraction(clickOn(span, a))).toBeNull()
    expect(classifyLinkInteraction(clickOn(a, a))).toBeNull()
  })

  it('a non-Element target (a raw text node) → null', () => {
    const a = link()
    const text = append(a, document.createElement('span')).appendChild(document.createTextNode('x'))
    expect(classifyLinkInteraction(clickOn(text, a))).toBeNull()
  })

  it("a nested link (markdown link / nested reference) → 'anchor' (it navigates natively)", () => {
    const a = link()
    const inner = append(a, document.createElement('a'))
    inner.href = 'https://example.com'
    const innerText = append(inner, document.createElement('span'))
    expect(classifyLinkInteraction(clickOn(inner, a))).toBe('anchor')
    expect(classifyLinkInteraction(clickOn(innerText, a))).toBe('anchor')
  })

  it("a media image → 'rich' (lightbox, not navigate)", () => {
    const a = link()
    const img = append(a, document.createElement('img'))
    expect(classifyLinkInteraction(clickOn(img, a))).toBe('rich')
  })

  it("a LINKED image (markdown link wraps the image) → 'anchor' (follow the link, not the lightbox)", () => {
    const a = link()
    const inner = append(a, document.createElement('a'))
    inner.href = 'https://example.com'
    const img = append(inner, document.createElement('img'))
    // The <img> (rich) sits closer to the target than the wrapping <a>, but an
    // explicit link is meant to be followed — anchor wins.
    expect(classifyLinkInteraction(clickOn(img, a))).toBe('anchor')
  })

  it("the video player + audio/canvas/button/[role=button] → 'rich'", () => {
    const a = link()
    const video = append(a, document.createElement('video'))
    video.setAttribute('controls', '')
    const iframe = append(a, document.createElement('iframe'))
    const audio = append(a, document.createElement('audio'))
    const button = append(a, document.createElement('button'))
    const roleButton = append(a, document.createElement('div'))
    roleButton.setAttribute('role', 'button')
    expect(classifyLinkInteraction(clickOn(video, a))).toBe('rich')
    expect(classifyLinkInteraction(clickOn(iframe, a))).toBe('rich')
    expect(classifyLinkInteraction(clickOn(audio, a))).toBe('rich')
    expect(classifyLinkInteraction(clickOn(button, a))).toBe('rich')
    expect(classifyLinkInteraction(clickOn(roleButton, a))).toBe('rich')
  })
})
