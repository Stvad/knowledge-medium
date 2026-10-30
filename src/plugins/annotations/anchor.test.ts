import {describe, expect, it} from 'vitest'
import {parseReferences} from '@/plugins/references/referenceParser.js'
import {captureAnchor, resolveAnchor, widenToReferenceSpans, widenToSpans, type RangeAnchor} from './anchor'

const captureQuote = (content: string, quote: string, occurrence = 0): RangeAnchor => {
  let from = -1
  for (let i = 0; i <= occurrence; i++) from = content.indexOf(quote, from + 1)
  if (from < 0) throw new Error(`"${quote}" not in "${content}"`)
  const anchor = captureAnchor(content, from, from + quote.length)
  if (!anchor) throw new Error('expected a range anchor')
  return anchor
}

describe('captureAnchor', () => {
  it('stores the quote, its start and up to 16 characters of context on each side', () => {
    const content = 'We moved the launch to Thursday because the vendor slipped.'
    expect(captureQuote(content, 'Thursday')).toEqual({
      quote: 'Thursday',
      quoteStart: 23,
      prefix: 'd the launch to ',
      suffix: ' because the ven',
    })
  })

  it('stores a shorter context when the quote is near the start or end of the block', () => {
    expect(captureQuote('Meet Thursday', 'Thursday')).toEqual({
      quote: 'Thursday', quoteStart: 5, prefix: 'Meet ', suffix: '',
    })
  })

  it('answers null for an empty selection, which is a whole-block thread', () => {
    expect(captureAnchor('Meet Thursday', 4, 4)).toBeNull()
  })

  it('widens a selection that cuts into a reference span', () => {
    const content = 'See [[Launch plan]] for details'
    // "plan]] for" — starts inside the wikilink
    const from = content.indexOf('plan')
    const anchor = captureAnchor(content, from, from + 'plan]] for'.length)
    expect(anchor?.quote).toBe('[[Launch plan]] for')
    expect(anchor?.quoteStart).toBe(4)
  })
})

describe('resolveAnchor', () => {
  it('is exact when the quote and both context windows are unchanged', () => {
    const content = 'We moved the launch to Thursday because the vendor slipped.'
    expect(resolveAnchor(content, captureQuote(content, 'Thursday')))
      .toEqual({state: 'exact', from: 23, to: 31})
  })

  it('is moved when the text is rewritten around the quote but its prefix still agrees', () => {
    const anchor = captureQuote('We moved the launch to Thursday because the vendor slipped.', 'Thursday')
    const rewritten = 'Because the vendor slipped, we moved the launch to Thursday.'
    expect(resolveAnchor(rewritten, anchor)).toEqual({state: 'moved', from: 51, to: 59})
  })

  // Nearest-to-hint would pick 19.
  it('after a prepend, picks the occurrence with the most context agreement, not the nearest one', () => {
    const anchor = captureQuote('Ship the fix, then test the fix.', 'the fix', 1)
    expect(anchor).toEqual({quote: 'the fix', quoteStart: 24, prefix: ' fix, then test ', suffix: '.'})
    const prepended = 'Note to self: Ship the fix, then test the fix.'
    expect(resolveAnchor(prepended, anchor)).toEqual({state: 'moved', from: 38, to: 45})
  })

  it('goes stale rather than jumping to another occurrence when the quoted one is deleted', () => {
    const anchor = captureQuote('Ship the fix, then test the fix.', 'the fix', 1)
    expect(resolveAnchor('Ship the fix, then test it.', anchor)).toEqual({state: 'stale'})
  })

  it('finds the quote by its prefix after a merge appends the target to another block', () => {
    const anchor = captureQuote('then test the fix.', 'the fix')
    expect(anchor.prefix).toBe('then test ')
    // A Backspace merge keeps the previous block's id and appends this one.
    expect(resolveAnchor('Ship the fix, then test the fix.', anchor))
      .toEqual({state: 'moved', from: 24, to: 31})
  })

  it('goes stale when the quoted text itself is edited', () => {
    const anchor = captureQuote('We moved the launch to Thursday because the vendor slipped.', 'Thursday')
    expect(resolveAnchor('We moved the launch to Friday because the vendor slipped.', anchor))
      .toEqual({state: 'stale'})
  })

  it('is moved, not exact, when text is inserted well before the quote', () => {
    const content = 'We moved the launch to Thursday because the vendor slipped.'
    const anchor = captureQuote(content, 'Thursday')
    expect(resolveAnchor(`Update: ${content}`, anchor)).toEqual({state: 'moved', from: 31, to: 39})
  })

  it('is exact when text changes far enough away that neither window sees it', () => {
    const content = 'We moved the launch to Thursday because the vendor slipped.'
    const anchor = captureQuote(content, 'Thursday')
    expect(resolveAnchor('We moved the launch to Thursday because the vendor slipped badly.', anchor))
      .toEqual({state: 'exact', from: 23, to: 31})
  })

  describe('at the end of the block (an empty stored suffix)', () => {
    const anchor = captureQuote('Meet Thursday', 'Thursday')

    it('is exact while the quote still ends the block', () => {
      expect(resolveAnchor('Meet Thursday', anchor)).toEqual({state: 'exact', from: 5, to: 13})
    })

    it('is not exact once text follows the quote, which is what refuses a second application', () => {
      expect(resolveAnchor('Meet Thursday 9am', anchor)).toEqual({state: 'moved', from: 5, to: 13})
    })
  })

  describe('at the start of the block (a stored prefix shorter than 16)', () => {
    const anchor = captureQuote('Hi Thursday works', 'Thursday')

    it('is exact while that prefix still begins the block', () => {
      expect(anchor.prefix).toBe('Hi ')
      expect(resolveAnchor('Hi Thursday works', anchor)).toEqual({state: 'exact', from: 3, to: 11})
    })

    it('is not exact when the quote stays at its start but the prefix no longer begins the block', () => {
      expect(resolveAnchor('Yo Thursday works', anchor)).toEqual({state: 'moved', from: 3, to: 11})
    })

    it('is not exact when text is prepended', () => {
      expect(resolveAnchor('Oh, Hi Thursday works', anchor)).toEqual({state: 'moved', from: 7, to: 15})
    })
  })

  describe('an empty stored context (the quote was the whole block)', () => {
    const anchor = captureQuote('Thursday', 'Thursday')

    it('stores no context', () => {
      expect(anchor).toEqual({quote: 'Thursday', quoteStart: 0, prefix: '', suffix: ''})
    })

    it('lets any occurrence qualify', () => {
      expect(resolveAnchor('Not Thursday', anchor)).toEqual({state: 'moved', from: 4, to: 12})
    })

    it('goes stale when the quote is gone', () => {
      expect(resolveAnchor('Friday', anchor)).toEqual({state: 'stale'})
    })
  })

  it('requires all of a stored context shorter than 4 characters to agree', () => {
    const anchor = captureQuote('a Thursday', 'Thursday')
    expect(anchor).toEqual({quote: 'Thursday', quoteStart: 2, prefix: 'a ', suffix: ''})
    // One of the two context characters agrees (the space): not enough.
    expect(resolveAnchor('b Thursday!', anchor)).toEqual({state: 'stale'})
    expect(resolveAnchor('xa Thursday', anchor)).toEqual({state: 'moved', from: 3, to: 11})
  })

  it('breaks a tie in context agreement by nearness to quoteStart', () => {
    const anchor: RangeAnchor = {quote: 'ab', quoteStart: 14, prefix: '1234', suffix: '5678'}
    expect(resolveAnchor('1234ab5678 1234ab5678', anchor)).toEqual({state: 'moved', from: 15, to: 17})
    expect(resolveAnchor('1234ab5678 1234ab5678', {...anchor, quoteStart: 3}))
      .toEqual({state: 'moved', from: 4, to: 6})
  })

  it('treats an empty quote as stale instead of looping', () => {
    expect(resolveAnchor('abc', {quote: '', quoteStart: 9, prefix: 'zz', suffix: ''})).toEqual({state: 'stale'})
  })

  it('is never exact at a start that is not a position in the text', () => {
    // Hand-made: `startsWith` reads -1 as 0 while the window slices from the
    // end, so a crafted prefix could otherwise match.
    const content = 'Thursday is fine'
    const crafted: RangeAnchor = {quote: 'Thursday', quoteStart: -1, prefix: 'Thursday is fin', suffix: 'y is fine'}
    expect(resolveAnchor(content, crafted).state).not.toBe('exact')
    expect(resolveAnchor(content, {quote: 'Thursday', quoteStart: 0.5, prefix: '', suffix: ' is fine'}).state).not.toBe('exact')
  })

  it('without a start hint is never exact, and ties go to the first occurrence', () => {
    const anchor: RangeAnchor = {quote: 'ab', quoteStart: undefined, prefix: '1234', suffix: '5678'}
    expect(resolveAnchor('1234ab5678 1234ab5678', anchor)).toEqual({state: 'moved', from: 4, to: 6})
  })

  describe('non-ASCII text', () => {
    it('anchors a quote containing astral characters and CJK', () => {
      const content = '会议改到 🎉星期四🎉 因为供应商延误了'
      const anchor = captureQuote(content, '星期四')
      expect(resolveAnchor(content, anchor)).toEqual({state: 'exact', from: anchor.quoteStart, to: anchor.quoteStart! + 3})
      expect(resolveAnchor(`备注：${content}`, anchor).state).toBe('moved')
    })

    it('never cuts a surrogate pair at the edge of the quote', () => {
      expect(captureAnchor('a😀b', 0, 2)?.quote).toBe('a😀')
      expect(captureAnchor('a😀b', 2, 4)?.quote).toBe('😀b')
    })

    it('never cuts a surrogate pair at the edge of a context window', () => {
      // 15 ASCII characters, then an emoji whose surrogate pair straddles the
      // 16-unit window boundary on the prefix side.
      const content = `😀${'x'.repeat(15)}QUOTE${'y'.repeat(15)}😀`
      const anchor = captureQuote(content, 'QUOTE')
      expect(anchor.prefix).toBe('x'.repeat(15))
      expect(anchor.suffix).toBe('y'.repeat(15))
      expect(resolveAnchor(content, anchor)).toEqual({state: 'exact', from: 17, to: 22})
    })
  })
})

describe('widenToReferenceSpans', () => {
  const ID = '3f2a9c1d-0000-4000-8000-000000000001'

  it('leaves a selection that cuts no span alone', () => {
    expect(widenToReferenceSpans('plain text here', 2, 6)).toEqual({from: 2, to: 6})
  })

  it('widens to a whole wikilink on either side', () => {
    const content = 'a [[Page Name]] b'
    expect(widenToReferenceSpans(content, 0, 6)).toEqual({from: 0, to: 15})
    expect(widenToReferenceSpans(content, 8, 17)).toEqual({from: 2, to: 17})
  })

  it('widens to the outermost of nested wikilinks', () => {
    const content = 'x [[a [[b]] c]] y'
    const inner = content.indexOf('b')
    expect(widenToReferenceSpans(content, inner, inner + 1)).toEqual({from: 2, to: 15})
  })

  it('widens to a whole block ref, embed and aliased block ref', () => {
    const ref = `see ((${ID})) now`
    expect(widenToReferenceSpans(ref, 0, 8)).toEqual({from: 0, to: 4 + ID.length + 4})
    const embed = `!((${ID})) tail`
    expect(widenToReferenceSpans(embed, 1, 3)).toEqual({from: 0, to: ID.length + 5})
    const aliased = `go [label](((${ID}))) on`
    expect(widenToReferenceSpans(aliased, 4, 6)).toEqual({from: 3, to: 3 + `[label](((${ID})))`.length})
  })

  it('leaves a selection that already covers whole spans unchanged', () => {
    const content = 'a [[Page]] b'
    expect(widenToReferenceSpans(content, 2, 10)).toEqual({from: 2, to: 10})
  })

  it('leaves an empty selection inside a span empty', () => {
    expect(widenToReferenceSpans('a [[Page]] b', 5, 5)).toEqual({from: 5, to: 5})
  })
})

describe('widening keeps the quote parsing as the target does', () => {
  // The root's content is the quote, and it is parsed like any block's. A cut
  // inside a run of brackets parses differently on its own (`[[[Page]]` is
  // `[Page`), which would mint a page for an alias nobody wrote.
  const aliasesOf = (text: string) => parseReferences(text).map(r => r.alias)

  it('holds for every selection of every short bracket string', () => {
    const alphabet = ['[', ']', 'a']
    const strings: string[] = ['']
    for (let length = 0; length < 7; length++) {
      for (const prefix of strings.filter(s => s.length === length)) for (const c of alphabet) strings.push(prefix + c)
    }
    const divergent: string[] = []
    for (const content of strings) {
      const spans = parseReferences(content)
      for (let from = 0; from <= content.length; from++) {
        for (let to = from + 1; to <= content.length; to++) {
          const anchor = captureAnchor(content, from, to)!
          const end = anchor.quoteStart! + anchor.quote.length
          const inside = spans.filter(s => s.startIndex >= anchor.quoteStart! && s.endIndex <= end).map(s => s.alias)
          if (JSON.stringify(aliasesOf(anchor.quote)) !== JSON.stringify(inside)) divergent.push(`${content} [${from},${to})`)
        }
      }
    }
    expect(divergent).toEqual([])
  })

  it('takes the ! of a page embed and the wrapper of a link-form wikilink', () => {
    const embed = 'see ![[Bee]] here'
    expect(captureAnchor(embed, 6, 9)?.quote).toBe('![[Bee]]')
    const linkForm = 'see [shown]([[Bee]]) here'
    expect(captureAnchor(linkForm, 14, 17)?.quote).toBe('[shown]([[Bee]])')
  })
})

describe('widenToSpans', () => {
  it('reaches a fixed point over spans that overlap without nesting', () => {
    // Listed so that one pass in order would widen into the second span and
    // stop, still cutting the first.
    const spans = [{startIndex: 0, endIndex: 10}, {startIndex: 8, endIndex: 20}]
    expect(widenToSpans(spans, 15, 16)).toEqual({from: 0, to: 20})
  })
})
