// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import {
  getElementScrollportBounds,
  isEditorElement,
  shouldExitEditModeAfterBlur,
} from '@/utils/dom.js'

describe('dom editor focus helpers', () => {
  it('treats textareas as editor elements', () => {
    const textarea = document.createElement('textarea')

    expect(isEditorElement(textarea)).toBe(true)
    expect(shouldExitEditModeAfterBlur(textarea)).toBe(false)
  })

  it('treats elements inside CodeMirror editors as editor elements', () => {
    const editor = document.createElement('div')
    editor.className = 'cm-editor'
    const content = document.createElement('div')
    editor.appendChild(content)

    expect(isEditorElement(content)).toBe(true)
    expect(shouldExitEditModeAfterBlur(content)).toBe(false)
  })

  it('exits edit mode when focus lands outside an editor', () => {
    const button = document.createElement('button')

    expect(isEditorElement(button)).toBe(false)
    expect(shouldExitEditModeAfterBlur(button)).toBe(true)
    expect(shouldExitEditModeAfterBlur(null)).toBe(true)
  })
})

describe('getElementScrollportBounds', () => {
  const stubRect = (el: HTMLElement, top: number, height: number): void => {
    el.getBoundingClientRect = () => ({
      top, bottom: top + height, left: 0, right: 100, width: 100, height,
      x: 0, y: top, toJSON: () => ({}),
    }) as DOMRect
  }

  const scrollport = (top: number, height: number): HTMLElement => {
    const el = document.createElement('div')
    el.style.overflowY = 'auto'
    stubRect(el, top, height)
    return el
  }

  it('clips to the nearest scrollport', () => {
    const port = scrollport(100, 300)
    const row = document.createElement('div')
    port.appendChild(row)
    document.body.appendChild(port)

    expect(getElementScrollportBounds(row)).toEqual({top: 100, bottom: 400})
  })

  // Panes nest: a note row sits inside the video-notes aside, and the whole
  // pane is clipped again by the scrollport a stacked slot wraps around it.
  // Honouring only the nearest left a row scrolled out of sight behind the
  // OUTER clip measuring as visible — so nothing scrolled it back into view and
  // nothing moved the cursor off it.
  it('clips through every scrollport between the element and the root', () => {
    const outer = scrollport(200, 300)   // visible band 200–500
    const inner = scrollport(100, 300)   // 100–400, but clipped by the outer
    outer.appendChild(inner)
    const row = document.createElement('div')
    inner.appendChild(row)
    document.body.appendChild(outer)

    expect(getElementScrollportBounds(row)).toEqual({top: 200, bottom: 400})
  })

  it('ignores ancestors that do not scroll', () => {
    const port = scrollport(100, 300)
    const plain = document.createElement('div')
    stubRect(plain, 0, 1000)
    port.appendChild(plain)
    const row = document.createElement('div')
    plain.appendChild(row)
    document.body.appendChild(port)

    expect(getElementScrollportBounds(row)).toEqual({top: 100, bottom: 400})
  })
})
