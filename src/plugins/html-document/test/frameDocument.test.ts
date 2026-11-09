// @vitest-environment happy-dom
import {describe, expect, it} from 'vitest'
import {
  buildFrameDocument,
  framePolicy,
  FRAME_SANDBOX,
  HEIGHT_MESSAGE_TYPE,
  MAX_FRAME_HEIGHT,
  MIN_FRAME_HEIGHT,
  READY_MESSAGE_TYPE,
  readFrameReport,
  SELECTION_MESSAGE_TYPE,
  textDigest,
} from '../frameDocument.ts'

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html')

const innerDocumentOf = (outerHtml: string) => {
  const frames = parse(outerHtml).querySelectorAll('iframe')
  expect(frames).toHaveLength(1)
  return frames[0]
}

describe('buildFrameDocument', () => {
  it('puts the policy on the outer document, ahead of the frame that holds the source', () => {
    const outer = parse(buildFrameDocument('<p>hello</p>', '', 'run'))
    const policy = outer.querySelector('meta[http-equiv="Content-Security-Policy"]')
    expect(policy?.getAttribute('content')).toBe(framePolicy(null))
    expect(outer.head.contains(policy)).toBe(true)
  })

  // Defence in depth: the browser suite passes without it, on inherited flags.
  it('sandboxes the inner frame itself, not only through what it inherits', () => {
    const inner = innerDocumentOf(buildFrameDocument('<p>hello</p>', '', 'run'))
    expect(inner.getAttribute('sandbox')).toBe(FRAME_SANDBOX)
  })

  it.each([
    ['a closing frame tag', '</iframe><script>alert(1)</script>'],
    ['a closing attribute quote', '"><script>alert(1)</script>'],
    ['already-escaped text', '&quot;&gt;&lt;script&gt;'],
    ['an unterminated comment', '<!-- <iframe>'],
    ['a closing head tag', '</head></html><script>alert(1)</script>'],
  ])('keeps %s inside the inner document', (_name, source) => {
    const outerHtml = buildFrameDocument(source, '', 'run')
    const outer = parse(outerHtml)
    expect(outer.querySelectorAll('script')).toHaveLength(0)
    expect(innerDocumentOf(outerHtml).getAttribute('srcdoc')).toContain(source)
  })

  it('opens the source in head context so a whole document keeps its own head and body', () => {
    const source = '<!doctype html><html lang="fr"><head><title>Own title</title></head><body class="own"><p>hi</p></body></html>'
    const inner = parse(innerDocumentOf(buildFrameDocument(source, '', 'run')).getAttribute('srcdoc') ?? '')
    expect(inner.title).toBe('Own title')
    expect(inner.documentElement.getAttribute('lang')).toBe('fr')
    expect(inner.body.className).toBe('own')
    expect(inner.body.querySelector('p')?.textContent).toBe('hi')
  })

  it('hands the theme to both documents', () => {
    const outerHtml = buildFrameDocument('', ':root{--foreground:1 2% 3%}', 'run')
    expect(parse(outerHtml).querySelector('style')?.textContent).toContain('--foreground:1 2% 3%')
    expect(innerDocumentOf(outerHtml).getAttribute('srcdoc')).toContain('--foreground:1 2% 3%')
  })
})

describe('a held document', () => {
  const nonceIn = (outerHtml: string) => /'nonce-([0-9a-f]+)'/.exec(outerHtml)?.[1]

  it('lets its reporter run by a nonce no other build shares', () => {
    const outer = buildFrameDocument('<p>x</p>', '', 'hold')
    const nonce = nonceIn(outer)
    expect(nonce).toHaveLength(32)
    expect(parse(outer).querySelector('iframe')?.getAttribute('srcdoc')).toContain(`<script nonce="${nonce}">`)
    expect(nonceIn(buildFrameDocument('<p>x</p>', '', 'hold'))).not.toBe(nonce)
  })

  it('gives a running document no nonce to read', () => {
    const outer = buildFrameDocument('<p>x</p>', '', 'run')
    expect(outer).not.toContain('nonce')
  })
})

describe('framePolicy', () => {
  it('lets author scripts run only when asked to', () => {
    expect(framePolicy(null)).toContain("script-src 'unsafe-inline'")
    expect(framePolicy('abc')).not.toContain("script-src 'unsafe-inline'")
    expect(framePolicy('abc')).toContain("script-src 'nonce-abc'")
  })
})

describe('readFrameReport', () => {
  const height = (value: unknown) => ({type: HEIGHT_MESSAGE_TYPE, height: value})
  const point = {text: 'some text', occurrence: 0, count: 1, offset: 2}
  const rect = {top: 1, left: 2, bottom: 3, right: 4}
  const selection = {start: point, end: point, rect, digest: '1:abc'}
  const reported = (value: unknown) => ({type: SELECTION_MESSAGE_TYPE, selection: value})

  it.each([
    [undefined], [null], ['text'], [7], [{}], [[]],
    [{type: 'other', height: 100}],
    [{selection}],
    [height('100')], [height(null)], [height(Number.NaN)], [height(Number.POSITIVE_INFINITY)],
  ])('reads %j as no report', data => {
    expect(readFrameReport(data)).toBeNull()
  })

  it('reads a height in range', () => {
    expect(readFrameReport(height(321))).toEqual({kind: 'height', height: 321})
  })

  it('rounds a height up so a fractional one does not clip the last line', () => {
    expect(readFrameReport(height(320.2))).toEqual({kind: 'height', height: 321})
  })

  it('clamps a height to the frame limits, so a document cannot take over the page or vanish', () => {
    expect(readFrameReport(height(1e9))).toEqual({kind: 'height', height: MAX_FRAME_HEIGHT})
    expect(readFrameReport(height(-5))).toEqual({kind: 'height', height: MIN_FRAME_HEIGHT})
  })

  it('reads that a document is ready', () => {
    expect(readFrameReport({type: READY_MESSAGE_TYPE})).toEqual({kind: 'ready'})
  })

  it.each([
    [null],
    ['text'],
    [{...selection, rect: undefined}],
    [{...selection, digest: undefined}],
    [{...selection, end: {...point, offset: -1}}],
    [{...selection, end: {...point, occurrence: 0.5}}],
    [{...selection, start: {...point, text: 7}}],
    [{...selection, start: {...point, count: -1}}],
    [{...selection, rect: {...rect, top: Number.NaN}}],
  ])('reads a selection of %j as none', value => {
    expect(readFrameReport(reported(value))).toEqual({kind: 'selection', selection: null})
  })

  it('reads a well-formed selection, and only what it names', () => {
    expect(readFrameReport(reported({...selection, start: {...point, extra: 1}, extra: 2})))
      .toEqual({kind: 'selection', selection})
  })
})

describe('textDigest', () => {
  it('tells apart text split differently into nodes, and the same text in another order', () => {
    const digests = [['ab'], ['a', 'b'], ['b', 'a'], ['a', 'b', '']].map(textDigest)
    expect(new Set(digests).size).toBe(digests.length)
  })
})
