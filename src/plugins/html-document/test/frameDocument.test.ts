// @vitest-environment happy-dom
import {describe, expect, it} from 'vitest'
import {
  buildFrameDocument,
  FRAME_CSP,
  FRAME_SANDBOX,
  HEIGHT_MESSAGE_TYPE,
  MAX_FRAME_HEIGHT,
  MIN_FRAME_HEIGHT,
  readReportedHeight,
} from '../frameDocument.ts'

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html')

const innerDocumentOf = (outerHtml: string) => {
  const frames = parse(outerHtml).querySelectorAll('iframe')
  expect(frames).toHaveLength(1)
  return frames[0]
}

describe('buildFrameDocument', () => {
  it('puts the policy on the outer document, ahead of the frame that holds the source', () => {
    const outer = parse(buildFrameDocument('<p>hello</p>', ''))
    const policy = outer.querySelector('meta[http-equiv="Content-Security-Policy"]')
    expect(policy?.getAttribute('content')).toBe(FRAME_CSP)
    expect(outer.head.contains(policy)).toBe(true)
  })

  // Defence in depth: the browser suite passes without it, on inherited flags.
  it('sandboxes the inner frame itself, not only through what it inherits', () => {
    const inner = innerDocumentOf(buildFrameDocument('<p>hello</p>', ''))
    expect(inner.getAttribute('sandbox')).toBe(FRAME_SANDBOX)
  })

  it.each([
    ['a closing frame tag', '</iframe><script>alert(1)</script>'],
    ['a closing attribute quote', '"><script>alert(1)</script>'],
    ['already-escaped text', '&quot;&gt;&lt;script&gt;'],
    ['an unterminated comment', '<!-- <iframe>'],
    ['a closing head tag', '</head></html><script>alert(1)</script>'],
  ])('keeps %s inside the inner document', (_name, source) => {
    const outerHtml = buildFrameDocument(source, '')
    const outer = parse(outerHtml)
    expect(outer.querySelectorAll('script')).toHaveLength(0)
    expect(innerDocumentOf(outerHtml).getAttribute('srcdoc')).toContain(source)
  })

  it('opens the source in head context so a whole document keeps its own head and body', () => {
    const source = '<!doctype html><html lang="fr"><head><title>Own title</title></head><body class="own"><p>hi</p></body></html>'
    const inner = parse(innerDocumentOf(buildFrameDocument(source, '')).getAttribute('srcdoc') ?? '')
    expect(inner.title).toBe('Own title')
    expect(inner.documentElement.getAttribute('lang')).toBe('fr')
    expect(inner.body.className).toBe('own')
    expect(inner.body.querySelector('p')?.textContent).toBe('hi')
  })

  it('hands the theme to both documents', () => {
    const outerHtml = buildFrameDocument('', ':root{--foreground:1 2% 3%}')
    expect(parse(outerHtml).querySelector('style')?.textContent).toContain('--foreground:1 2% 3%')
    expect(innerDocumentOf(outerHtml).getAttribute('srcdoc')).toContain('--foreground:1 2% 3%')
  })
})

describe('readReportedHeight', () => {
  const message = (height: unknown) => ({type: HEIGHT_MESSAGE_TYPE, height})

  it.each([
    [undefined], [null], ['text'], [7], [{}], [[]],
    [{type: 'other', height: 100}],
    [message('100')], [message(null)], [message(Number.NaN)], [message(Number.POSITIVE_INFINITY)],
  ])('ignores %j', data => {
    expect(readReportedHeight(data)).toBeNull()
  })

  it('reads a height in range', () => {
    expect(readReportedHeight(message(321))).toBe(321)
  })

  it('rounds up so a fractional height does not clip the last line', () => {
    expect(readReportedHeight(message(320.2))).toBe(321)
  })

  it('clamps to the frame limits, so a document cannot take over the page or vanish', () => {
    expect(readReportedHeight(message(1e9))).toBe(MAX_FRAME_HEIGHT)
    expect(readReportedHeight(message(-5))).toBe(MIN_FRAME_HEIGHT)
  })
})
