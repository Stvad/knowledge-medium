// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { clipboardHtmlFor, clipboardTextFor, outlineFromClipboard, type OutlineEntry } from '../clipboardOutline'

const carried = (entries: OutlineEntry[]) => {
  const text = clipboardTextFor(entries)
  return {text, html: clipboardHtmlFor(entries, text)!}
}

const MULTI_LINE: OutlineEntry[] = [{depth: 0, content: 'a\nb'}, {depth: 1, content: 'c'}]

describe('clipboardHtmlFor', () => {
  it.each<[string, OutlineEntry[]]>([
    ['a plain outline', [{depth: 0, content: 'a'}, {depth: 1, content: 'b'}, {depth: 2, content: 'c'}]],
    ['a plain single line', [{depth: 0, content: 'a'}]],
    ['several plain lines', [{depth: 0, content: 'a'}, {depth: 0, content: 'b'}]],
    ['a lone fence, which the parser keeps whole', [{depth: 0, content: '```\ncode\n```'}]],
  ])('adds no html for %s, whose text already parses back exactly', (_, entries) => {
    expect(clipboardHtmlFor(entries, clipboardTextFor(entries))).toBeUndefined()
  })

  it.each<[string, OutlineEntry[]]>([
    ['a block its continuation line would split', [{depth: 0, content: 'a\nb'}]],
    ['edge whitespace the parser would trim', [{depth: 0, content: 'a'}, {depth: 1, content: '  b  '}]],
    ['a lone block whose own marker would read as a bullet', [{depth: 0, content: '- foo'}]],
    ['a lone empty block, whose text parses to nothing', [{depth: 0, content: ''}]],
    ['an unpaired surrogate the clipboard write would replace', [{depth: 0, content: 'a\uD83D'}]],
  ])('adds html for %s', (_, entries) => {
    expect(clipboardHtmlFor(entries, clipboardTextFor(entries))).toBeDefined()
  })

  it('renders the html as the text, one element per line', () => {
    const {text, html} = carried(MULTI_LINE)
    const body = new DOMParser().parseFromString(html, 'text/html').body
    const lines = [...body.firstElementChild!.children].map(line => line.textContent)
    expect(lines).toEqual(text.split('\n'))
  })

  it('keeps a blank line visible', () => {
    const html = carried([{depth: 0, content: 'a\n\nb'}]).html
    const [, blank] = new DOMParser().parseFromString(html, 'text/html').body.firstElementChild!.children
    expect(blank.innerHTML).toBe('<br>')
  })

  it('escapes content rather than rendering it', () => {
    const html = carried([{depth: 0, content: '<img src=x>\n&amp;"'}]).html
    const body = new DOMParser().parseFromString(html, 'text/html').body
    expect(body.querySelector('img')).toBeNull()
    expect(body.textContent).toBe('<img src=x>&amp;"')
  })

  it('carries only each block\'s depth and content', () => {
    const entries = [{depth: 0, content: 'a\nb', id: 'secret-id', properties: {x: 1}}]
    expect(clipboardHtmlFor(entries, clipboardTextFor(entries))).not.toContain('secret-id')
  })
})

describe('outlineFromClipboard', () => {
  it('rebuilds the outline from the payload', () => {
    const {text, html} = carried(MULTI_LINE)
    expect(outlineFromClipboard(html, text)).toEqual([
      {content: 'a\nb', children: [{content: 'c', children: []}]},
    ])
  })

  it('restores content that looks like html or an entity', () => {
    const entries = [{depth: 0, content: '<b>&amp;"\'\n\u2028 \uD83D\uDE00'}]
    const {text, html} = carried(entries)
    expect(outlineFromClipboard(html, text)).toEqual([{content: entries[0].content, children: []}])
  })

  it('restores an unpaired surrogate the clipboard text lost', () => {
    const entries = [{depth: 0, content: 'a\uD83D'}]
    const {html} = carried(entries)
    expect(outlineFromClipboard(html, 'a\uFFFD')).toEqual([{content: 'a\uD83D', children: []}])
  })

  it('accepts text whose line endings a platform rewrote', () => {
    const {text, html} = carried(MULTI_LINE)
    expect(outlineFromClipboard(html, text.replace(/\n/g, '\r\n'))).not.toBeNull()
  })

  it('accepts a browser re-serializing the html around the payload', () => {
    const {text, html} = carried(MULTI_LINE)
    expect(outlineFromClipboard(`<meta charset='utf-8'><html><head></head><body>${html}</body></html>`, text)).not.toBeNull()
  })

  it('refuses a payload that disagrees with the text beside it', () => {
    const {html} = carried(MULTI_LINE)
    expect(outlineFromClipboard(html, 'something copied since')).toBeNull()
  })

  it.each([undefined, '', '<p>from another app</p>'])('finds nothing in %j', html => {
    expect(outlineFromClipboard(html, 'text')).toBeNull()
  })

  const withPayload = (payload: string) => `<div data-km-outline='${payload}'></div>`

  // Each text is what that payload's entries would serialize to, so only the
  // shape check can refuse it.
  it.each([
    ['not json', '{nope', ''],
    ['not a list', '{"depth":0,"content":"a"}', ''],
    ['an empty list', '[]', ''],
    ['a first entry below the top', '[{"depth":1,"content":"a"}]', '  - a'],
    ['a level skipped', '[{"depth":0,"content":"a"},{"depth":2,"content":"b"}]', '- a\n    - b'],
    ['a negative depth', '[{"depth":-1,"content":"a"}]', '- a'],
    ['a fractional depth', '[{"depth":0,"content":"a"},{"depth":0.5,"content":"b"}]', '- a\n- b'],
    ['content that is not text', '[{"depth":0,"content":"a"},{"depth":0,"content":1}]', 'a\n1'],
  ])('refuses a malformed payload: %s', (_, payload, text) => {
    expect(outlineFromClipboard(withPayload(payload), text)).toBeNull()
  })
})
