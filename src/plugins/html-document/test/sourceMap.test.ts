import {describe, expect, it} from 'vitest'
import {textDigest, type FramePoint} from '../frameDocument.ts'
import {marksOf, rangeOfSelection, textSpansOf} from '../sourceMap.ts'

/** What a frame holding exactly the text `source` parses to reports. */
const digestOf = (source: string) => textDigest(textSpansOf(source).map(span => span.value))

/** The selection such a frame would report from `start` to `end`, each the
 *  first text node with that text and an offset into it. */
const selectionIn = (source: string, start: [string, number], end: [string, number]) => {
  const spans = textSpansOf(source)
  const point = ([text, offset]: [string, number]): FramePoint => {
    const count = spans.filter(span => span.value === text).length
    if (count === 0) throw new Error(`no text node ${JSON.stringify(text)}`)
    return {text, occurrence: 0, count, offset}
  }
  return {start: point(start), end: point(end), digest: digestOf(source)}
}

const sliceOf = (source: string, start: [string, number], end: [string, number]) => {
  const range = rangeOfSelection(source, selectionIn(source, start, end))
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

  it('walks a source nested deeper than a call stack goes', () => {
    expect(textSpansOf(`${'<div>'.repeat(6000)}deep`).at(-1)?.value).toBe('deep')
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

  it('maps a NUL as the frame receives it, as U+FFFD', () => {
    expect(sliceOf('<p>a\u0000b</p>', ['a\uFFFDb', 1], ['a\uFFFDb', 3])).toBe('\u0000b')
  })

  it('refuses an end inside what one reference expands to', () => {
    const source = '<p>x&#x1F600;y</p>'
    expect(typeof rangeOfSelection(source, selectionIn(source, ['x😀y', 0], ['x😀y', 2]))).toBe('string')
    expect(sliceOf(source, ['x😀y', 0], ['x😀y', 3])).toBe('x&#x1F600;')
  })

  it('refuses text the tree builder moved out of a table and merged', () => {
    const source = '<table>x<tr><td>cell</td></tr>y</table>'
    expect(textSpansOf(source).map(span => span.value)).toEqual(['xy', 'cell'])
    expect(typeof rangeOfSelection(source, selectionIn(source, ['xy', 0], ['cell', 2]))).toBe('string')
    expect(sliceOf(source, ['cell', 0], ['cell', 4])).toBe('cell')
  })

  it('tells repeated text apart by which occurrence it is', () => {
    const source = '<p>same</p><p>same</p>'
    const second = {text: 'same', occurrence: 1, count: 2, offset: 0}
    expect(rangeOfSelection(source, {start: second, end: {...second, offset: 4}, digest: digestOf(source)}))
      .toEqual({from: source.lastIndexOf('same'), to: source.lastIndexOf('same') + 4})
  })

  it('refuses an empty selection', () => {
    expect(rangeOfSelection('<p>Hello</p>', selectionIn('<p>Hello</p>', ['Hello', 2], ['Hello', 2])))
      .toBe('Select some text first.')
  })

  describe('in a frame whose text is not what the source parses to', () => {
    const SOURCE = '<p>same</p><p>same</p><p>once</p>'
    const at = (text: string, occurrence: number, count: number) => ({
      start: {text, occurrence, count, offset: 0},
      end: {text, occurrence, count, offset: text.length},
      digest: 'another document',
    })

    it('places text found once in the frame and once in the source', () => {
      expect(rangeOfSelection(SOURCE, at('once', 0, 1)))
        .toEqual({from: SOURCE.indexOf('once'), to: SOURCE.indexOf('once') + 4})
    })

    it('refuses text the source repeats, even where the frame has one copy left', () => {
      expect(rangeOfSelection(SOURCE, at('same', 0, 1))).toMatch(/not what its source parses to/)
    })

    it('refuses text the frame repeats', () => {
      expect(rangeOfSelection(SOURCE, at('once', 1, 2))).toMatch(/not what its source parses to/)
      expect(rangeOfSelection(SOURCE, at('once', 0, 2))).toMatch(/not what its source parses to/)
    })

    it('refuses text the source does not have', () => {
      expect(rangeOfSelection(SOURCE, at('typed in', 0, 1))).toMatch(/not what its source parses to/)
    })
  })
})

describe('marksOf', () => {
  const source = '<p>one <b>two</b> three</p><p title="three">Tom &amp; Jerry</p>'
  const at = (quote: string, from = 0) => {
    const start = source.indexOf(quote, from)
    return {from: start, to: start + quote.length, moved: false, suggestion: false}
  }

  it('places each end of a range in the text node that holds it, with the digest of that text', () => {
    expect(marksOf(source, [at('ne <b>two</b> thr')])).toEqual({
      digest: digestOf(source),
      marks: [{start: {node: 0, offset: 1}, end: {node: 2, offset: 4}, kind: 'comment'}],
    })
  })

  it('names the kind from the highlight\'s style', () => {
    const kinds = marksOf(source, [
      {...at('two'), moved: true},
      {...at('Jerry'), suggestion: true},
      {...at('Tom'), suggestion: true, moved: true},
    ]).marks.map(mark => mark.kind)
    expect(kinds).toEqual(['comment-moved', 'suggestion', 'suggestion-moved'])
  })

  it('places an end beside a character reference in the text it decodes to', () => {
    expect(marksOf(source, [at('&amp; Jerry')]).marks).toEqual([{
      start: {node: 3, offset: 4}, end: {node: 3, offset: 11}, kind: 'comment',
    }])
  })

  it('draws nothing for a range with an end outside text', () => {
    // A moved anchor can resolve to the same text in an attribute.
    expect(marksOf(source, [at('three', source.indexOf('title'))]).marks).toEqual([])
    expect(marksOf(source, [at('amp')]).marks).toEqual([])
  })
})
