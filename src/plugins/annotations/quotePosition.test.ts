// @vitest-environment happy-dom
import {describe, expect, it} from 'vitest'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type {PluggableList} from 'unified'
import {remarkWikilinks} from '@/plugins/references/markdown/wikilinks/remark-wikilinks.js'
import {renderedPoint} from './quotePosition.ts'
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

/** The rendered text from the point on, to the end of its text node. */
const textFrom = (root: Element, content: string, at: number) => {
  const point = renderedPoint(root, KEY, content, at)
  return point && point.text.data.slice(point.offset)
}

describe('renderedPoint', () => {
  it('finds an offset in the paragraph, the list and the marked text alike', () => {
    const content = 'first line\n\n- an item\n- quoted *here*'
    const at = content.indexOf('quoted')
    const root = rendered(content, [{from: at, to: at + 6, moved: false, suggestion: false}])
    expect(textFrom(root, content, content.indexOf('line'))).toBe('line')
    expect(textFrom(root, content, content.indexOf('item'))).toBe('item')
    expect(textFrom(root, content, at)).toBe('quoted')
    expect(textFrom(root, content, content.indexOf('here'))).toBe('here')
  })

  it('takes the text after a quote that starts inside a reference', () => {
    const content = 'see [[Some page]] and more'
    expect(textFrom(rendered(content), content, content.indexOf('Some'))).toBe(' and more')
  })

  it('finds nothing in a render of other content, or under another key', () => {
    const content = 'first line'
    const root = rendered(content)
    expect(renderedPoint(root, KEY, 'first lime', 0)).toBeNull()
    expect(renderedPoint(root, '7.00000000', content, 0)).toBeNull()
  })
})
