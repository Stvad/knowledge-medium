// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { isElementProperlyVisible } from './dom'

const rowAt = (top: number, height: number): HTMLElement => {
  const el = document.createElement('div')
  el.style.lineHeight = '24px'
  document.body.appendChild(el)
  el.getBoundingClientRect = () =>
    ({top, bottom: top + height, left: 0, right: 100, width: 100, height, x: 0, y: top, toJSON: () => ({})}) as DOMRect
  return el
}

describe('isElementProperlyVisible', () => {
  const bounds = {top: 0, bottom: 500}

  it('counts a row shorter than its line height as visible once all of it is in view', () => {
    expect(isElementProperlyVisible(rowAt(100, 20), bounds)).toBe(true)
    expect(isElementProperlyVisible(rowAt(490, 20), bounds)).toBe(false)
  })

  it('still asks a taller row for a whole line in view', () => {
    expect(isElementProperlyVisible(rowAt(480, 60), bounds)).toBe(false)
    expect(isElementProperlyVisible(rowAt(470, 60), bounds)).toBe(true)
  })

  it('never counts an element with no height', () => {
    expect(isElementProperlyVisible(rowAt(100, 0), bounds)).toBe(false)
  })
})
