// @vitest-environment happy-dom
import {describe, expect, it} from 'vitest'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type {PluggableList} from 'unified'
import {remarkWikilinks} from '@/plugins/references/markdown/wikilinks/remark-wikilinks.js'
import {contentEditor, renderedPoint} from './quotePosition.ts'
import {remarkAnnotationMarks} from './readHighlights.ts'
import type {HighlightRange} from './highlights.ts'

const KEY = '7.deadbeef'

/** Content rendered the way read mode renders it, the spans recorded under
 *  `KEY`, with `ranges` marked. */
const rendered = (content: string, ranges: readonly HighlightRange[] = []): HTMLElement => {
  const remarkPlugins: PluggableList = [
    remarkGfm,
    [remarkWikilinks, {resolveAlias: (alias: string) => `id-${alias}`}],
    [remarkAnnotationMarks, {content, ranges, sourceKey: KEY}],
  ]
  const root = document.createElement('div')
  root.innerHTML = renderToStaticMarkup(createElement(Markdown, {remarkPlugins}, content))
  return root
}

/** The rendered text from where `quote` starts on, to the end of its text
 *  node. */
const textFrom = (root: Element, content: string, quote: string) => {
  const at = content.indexOf(quote)
  const point = renderedPoint(root, KEY, content, at, at + quote.length)
  return point && point.text.data.slice(point.offset)
}

describe('renderedPoint', () => {
  it('finds an offset in the paragraph, the list and the marked text alike', () => {
    const content = 'first line\n\n- an item\n- quoted *here*'
    const at = content.indexOf('quoted')
    const root = rendered(content, [{from: at, to: at + 6, moved: false, suggestion: false}])
    expect(textFrom(root, content, 'line')).toBe('line')
    expect(textFrom(root, content, 'item')).toBe('item')
    expect(textFrom(root, content, 'quoted')).toBe('quoted')
    expect(textFrom(root, content, 'here')).toBe('here')
  })

  it('takes the text after a quote that starts with a reference', () => {
    const content = '[[Some page]] and more'
    expect(textFrom(rendered(content), content, '[[Some page]] and')).toBe(' and more')
  })

  it('finds nothing where the text after a reference quote is past the quote', () => {
    const content = 'see [[Some page]]\n\nnext paragraph'
    expect(textFrom(rendered(content), content, '[[Some page]]')).toBeNull()
  })

  it('finds nothing in a render of other content, or under another key', () => {
    const content = 'first line'
    const root = rendered(content)
    expect(renderedPoint(root, KEY, 'first lime', 0, 5)).toBeNull()
    expect(renderedPoint(root, '7.00000000', content, 0, 5)).toBeNull()
  })
})

describe('contentEditor', () => {
  const shell = (inner: string) => {
    const root = document.createElement('div')
    root.innerHTML = `<div data-block-shell data-block-id="r">${inner}</div>`
    return root.firstElementChild!
  }

  it("finds the editor in the row's own content", () => {
    const row = shell('<div class="block-content"><div class="cm-editor" id="own"></div></div>')
    expect(contentEditor(row)?.id).toBe('own')
  })

  it("ignores an editor below the content, and a nested row's", () => {
    const row = shell(
      '<div class="block-content"><p>read mode</p></div>' +
      '<div class="cm-editor" id="composer"></div>' +
      '<div data-block-shell data-block-id="child"><div class="block-content"><div class="cm-editor"></div></div></div>',
    )
    expect(contentEditor(row)).toBeUndefined()
  })
})
