import {describe, expect, it} from 'vitest'
import type {FramePoint} from '../frameDocument.ts'
import {marksOf, rangeOfSelection, textSpansOf, type TextSpan} from '../sourceMap.ts'

/** The selection a frame would report from `start` to `end`, each the first
 *  text node with that text and an offset into it. */
const selectionIn = (spans: readonly TextSpan[], start: [string, number], end: [string, number]) => {
  const point = ([text, offset]: [string, number]): FramePoint => {
    const count = spans.filter(span => span.value === text).length
    if (count === 0) throw new Error(`no text node ${JSON.stringify(text)}`)
    return {text, occurrence: 0, count, offset}
  }
  return {start: point(start), end: point(end)}
}

const sliceOf = (source: string, start: [string, number], end: [string, number]) => {
  const range = rangeOfSelection(textSpansOf(source), selectionIn(textSpansOf(source), start, end), 'hold')
  if (typeof range === 'string') throw new Error(range)
  return source.slice(range.from, range.to)
}

describe('textSpansOf', () => {
  it('lists the body text nodes in document order, as the browser parses them', () => {
    const values = textSpansOf('<title>T</title><p>one <b>two</b></p>three').map(span => span.value)
    expect(values).toEqual(['one ', 'two', 'three'])
  })

  it('parses a whole document as the frame does, after the head the app opens', () => {
    const values = textSpansOf('<!doctype html><html><head><title>T</title></head><body><p>x</p></body></html>')
      .map(span => span.value)
    expect(values).toEqual(['x'])
  })

  it('leaves a template\'s content out, as the DOM does', () => {
    expect(textSpansOf('<p>a</p><template><p>hidden</p></template><p>b</p>').map(span => span.value))
      .toEqual(['a', 'b'])
  })
})

describe('rangeOfSelection', () => {
  it('maps plain text to the same text in the source', () => {
    expect(sliceOf('<p>Hello world</p>', ['Hello world', 6], ['Hello world', 11])).toBe('world')
  })

  it('maps a selection across elements to the source between its ends', () => {
    expect(sliceOf('<p>one <b>two</b> three</p>', ['one ', 1], [' three', 4])).toBe('ne <b>two</b> thr')
  })

  it('maps around a character reference to the reference whole', () => {
    const source = '<p>Tom &amp; Jerry</p>'
    expect(sliceOf(source, ['Tom & Jerry', 6], ['Tom & Jerry', 11])).toBe('Jerry')
    expect(sliceOf(source, ['Tom & Jerry', 4], ['Tom & Jerry', 11])).toBe('&amp; Jerry')
    expect(sliceOf(source, ['Tom & Jerry', 0], ['Tom & Jerry', 5])).toBe('Tom &amp;')
  })

  it('reads a legacy reference with no semicolon as the parser does', () => {
    expect(sliceOf('<p>&copy 2024 me</p>', ['© 2024 me', 2], ['© 2024 me', 6])).toBe('2024')
  })

  it('keeps an ampersand that starts no reference as itself', () => {
    expect(sliceOf('<p>a & b &zzz; c</p>', ['a & b &zzz; c', 2], ['a & b &zzz; c', 11])).toBe('& b &zzz;')
  })

  it('maps text whose line endings the parser normalised', () => {
    expect(sliceOf('<p>a\r\nb\rc</p>', ['a\nb\nc', 2], ['a\nb\nc', 5])).toBe('b\rc')
  })

  it('refuses an end inside what one reference expands to', () => {
    const source = '<p>x&#x1F600;y</p>'
    const spans = textSpansOf(source)
    expect(typeof rangeOfSelection(spans, selectionIn(spans, ['x😀y', 0], ['x😀y', 2]), 'hold')).toBe('string')
    expect(sliceOf(source, ['x😀y', 0], ['x😀y', 3])).toBe('x&#x1F600;')
  })

  it('refuses a text node whose DOM text is not what the source parses to', () => {
    const spans = textSpansOf('<p>Hello world</p>')
    const selection = selectionIn(spans, ['Hello world', 0], ['Hello world', 5])
    const rewritten = {...selection, start: {...selection.start, text: 'Hello there'}}
    expect(typeof rangeOfSelection(spans, rewritten, 'hold')).toBe('string')
  })

  it('refuses a node the frame has and the source does not', () => {
    const spans = textSpansOf('<p>Hello</p>')
    const start = {text: 'Hello', occurrence: 1, count: 2, offset: 0}
    expect(typeof rangeOfSelection(spans, {start, end: {...start, offset: 5}}, 'hold')).toBe('string')
  })

  it('tells repeated text apart by which occurrence it is', () => {
    const source = '<p>same</p><p>same</p>'
    const spans = textSpansOf(source)
    const second = {text: 'same', occurrence: 1, count: 2, offset: 0}
    expect(rangeOfSelection(spans, {start: second, end: {...second, offset: 4}}, 'hold'))
      .toEqual({from: source.lastIndexOf('same'), to: source.lastIndexOf('same') + 4})
  })

  it('maps a NUL as the frame receives it, as U+FFFD', () => {
    expect(sliceOf('<p>a\0b</p>', ['a�b', 1], ['a�b', 3])).toBe('\0b')
  })

  it('refuses text the tree builder moved out of a table and merged', () => {
    const source = '<table>x<tr><td>cell</td></tr>y</table>'
    const spans = textSpansOf(source)
    expect(spans.map(span => span.value)).toEqual(['xy', 'cell'])
    expect(typeof rangeOfSelection(spans, selectionIn(spans, ['xy', 0], ['cell', 2]), 'hold')).toBe('string')
    expect(sliceOf(source, ['cell', 0], ['cell', 4])).toBe('cell')
  })

  describe('while the document\'s scripts run', () => {
    const SOURCE = '<p>same</p><p>same</p><p>once</p>'
    const spans = textSpansOf(SOURCE)
    const at = (text: string, occurrence: number, count: number) => ({
      start: {text, occurrence, count, offset: 0},
      end: {text, occurrence, count, offset: text.length},
    })

    it('places text that appears once in the frame and once in the source', () => {
      expect(rangeOfSelection(spans, at('once', 0, 1), 'run'))
        .toEqual({from: SOURCE.indexOf('once'), to: SOURCE.indexOf('once') + 4})
    })

    it('refuses text the source repeats, even once a script left one copy in the frame', () => {
      expect(rangeOfSelection(spans, at('same', 0, 1), 'run')).toMatch(/scripts run/)
    })

    it('refuses text a script repeated in the frame', () => {
      expect(rangeOfSelection(spans, at('once', 1, 2), 'run')).toMatch(/scripts run/)
      expect(rangeOfSelection(spans, at('once', 0, 2), 'run')).toMatch(/scripts run/)
    })
  })

  it('refuses an empty selection', () => {
    const spans = textSpansOf('<p>Hello</p>')
    expect(rangeOfSelection(spans, selectionIn(spans, ['Hello', 2], ['Hello', 2]), 'hold')).toBe('Select some text first.')
  })
})

describe('marksOf', () => {
  const source = '<p>one <b>two</b> three</p><p title="three">Tom &amp; Jerry</p>'
  const spans = textSpansOf(source)
  const at = (quote: string, from = 0) => {
    const start = source.indexOf(quote, from)
    return {from: start, to: start + quote.length, moved: false, suggestion: false}
  }

  it('places each end of a range in the text node that holds it', () => {
    expect(marksOf(spans, [at('ne <b>two</b> thr')])).toEqual([{
      start: {node: 0, offset: 1}, end: {node: 2, offset: 4}, kind: 'comment',
    }])
  })

  it('names the kind from the highlight\'s style', () => {
    const kinds = marksOf(spans, [
      {...at('two'), moved: true},
      {...at('Jerry'), suggestion: true},
      {...at('Tom'), suggestion: true, moved: true},
    ]).map(mark => mark.kind)
    expect(kinds).toEqual(['comment-moved', 'suggestion', 'suggestion-moved'])
  })

  it('places an end beside a character reference in the text it decodes to', () => {
    expect(marksOf(spans, [at('&amp; Jerry')])).toEqual([{
      start: {node: 3, offset: 4}, end: {node: 3, offset: 11}, kind: 'comment',
    }])
  })

  it('draws nothing for a range with an end outside text', () => {
    // A moved anchor can resolve to the same text in an attribute.
    expect(marksOf(spans, [at('three', source.indexOf('title'))])).toEqual([])
    expect(marksOf(spans, [at('amp')])).toEqual([])
  })
})
