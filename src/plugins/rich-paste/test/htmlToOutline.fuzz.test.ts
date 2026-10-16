// @vitest-environment happy-dom
/**
 * Fuzz suite for `convertClipboardHtml` — see `src/test/fuzz.ts` for the
 * smoke/deep tier mechanics. It runs inside the paste handler on whatever
 * HTML another app put on the clipboard, so the oracles are over tag soup:
 * - totality: never throws, and an outline never contains a block that
 *   renders to nothing — no text, no image once its markdown is read back
 *   (every front-end branch skips such content);
 * - no silent loss: a paste not deferred to the plain text shows every letter
 *   and digit of the HTML's content, in order. The converter's own
 *   `keepsAllText` defers when the html→mdast step drops text, but checks
 *   only that step, and only when there is plain text to defer to. With none
 *   there is nothing better to paste, which is why the arbitrary has no
 *   element the converter ignores (`<math>`, `<menu>`…).
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { Nodes } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { fuzzParams, fuzzTestTimeout } from '@/test/fuzz'
import type { OutlineNode } from '@/utils/markdownParser'
import { convertClipboardHtml } from '../htmlToOutline'
import { normalizeClipboardDom } from '../normalizeClipboardDom'

const openTagArb = fc.constantFrom(
  '<h1>', '<h3>', '<p>', '<ul>', '<ol start="2">', '<li>', '<b>', '<i>', '<del>', '<code>', '<pre>',
  '<blockquote>', '<table>', '<tr>', '<td>', '<th>', '<thead>', '<a href="https://e.com/">', '<a href="#x">',
  '<span style="font-weight:700">', '<b style="font-weight:normal;" id="docs-internal-guid-1">',
  '<div>', '<sup class="reference">', '<button>', '<details>', '<summary>',
)
const closeTagArb = fc.constantFrom(
  '</h1>', '</h3>', '</p>', '</ul>', '</ol>', '</li>', '</b>', '</i>', '</del>', '</code>', '</pre>',
  '</blockquote>', '</table>', '</tr>', '</td>', '</th>', '</thead>', '</a>', '</span>', '</div>',
)
const leafArb = fc.oneof(
  fc.constantFrom('<br>', '<img src="https://e.com/i.png" alt="i">', '<img src="data:x">', '<hr>', '&nbsp;', '\n'),
  // `fc.string` draws ASCII only; the serializer has handled a character by its UTF-16 code units.
  fc.constantFrom('é', '𝐀'),
  fc.string({maxLength: 6}),
)
const htmlArb = fc.array(fc.oneof(openTagArb, closeTagArb, leafArb), {maxLength: 24}).map(parts => parts.join(''))

const rendersSomething = (node: Nodes): boolean =>
  node.type === 'image' ||
  ('value' in node && node.value.trim() !== '') ||
  ('children' in node && node.children.some(rendersSomething))

const blankBlocks = (nodes: readonly OutlineNode[]): string[] =>
  nodes.flatMap(node => [
    ...(rendersSomething(fromMarkdown(node.content)) ? [] : [JSON.stringify(node.content)]),
    ...blankBlocks(node.children ?? []),
  ])

/** The HTML's text as the converter reads it: `normalizeClipboardDom` drops
 *  what isn't content (controls, citation markers, a `<pre>`'s chrome) on
 *  purpose. */
const contentText = (html: string): string => {
  const body = new DOMParser().parseFromString(html, 'text/html').body
  normalizeClipboardDom(body)
  return body.textContent ?? ''
}

const alphanumerics = (text: string): string => text.replace(/[^\p{L}\p{N}]/gu, '')

const documentOrder = (nodes: readonly OutlineNode[]): string[] =>
  nodes.flatMap(node => [node.content, ...documentOrder(node.children ?? [])])

/** The text `markdown` shows once read back: markdown spells some characters
 *  as escapes or character references (`&#x41;**!**`, so the bold can open
 *  after a letter), and the renderer drops raw html. */
const shownText = (markdown: string): string => literalText(fromMarkdown(markdown))

const literalText = (node: Nodes): string =>
  node.type === 'html' ? '' : 'value' in node ? node.value : 'children' in node ? node.children.map(literalText).join('') : ''

/** What is left of `expected` once each of its characters is matched in
 *  order against `output`: empty when `expected` is a subsequence of it. A
 *  subsequence, because the converter adds text of its own (a task item's
 *  `[x]`, which reads back as text). */
const unmatched = (expected: string, output: string): string => {
  const wanted = [...expected]
  let matched = 0
  for (const char of output) if (char === wanted[matched]) matched++
  return wanted.slice(matched).join('')
}

/** An html-only clipboard, or one whose plain text carries no references. */
const plainTextArb = fc.constantFrom('', 'copied text')

/** A property over a clipboard that lets the current task end every few
 *  hundred cases: happy-dom's query caches hold `WeakRef`s, which keep every
 *  parsed document alive until the task ends, and a synchronous property never
 *  ends it — a deep run would exhaust the heap. */
const clipboardProperty = (predicate: (html: string, plainText: string) => void) => {
  let cases = 0
  return fc.asyncProperty(htmlArb, plainTextArb, async (html, plainText) => {
    predicate(html, plainText)
    if (++cases % 500 === 0) await new Promise(resolve => setTimeout(resolve, 0))
  })
}

describe('convertClipboardHtml: tag soup', () => {
  it('never throws and never yields a blank block', async () => {
    await fc.assert(
      clipboardProperty((html, plainText) => {
        const result = convertClipboardHtml(html, plainText)
        if (result.kind === 'outline') expect(blankBlocks(result.blocks)).toEqual([])
        if (result.kind === 'inline') expect(blankBlocks([{content: result.markdown}])).toEqual([])
      }),
      fuzzParams(150),
    )
  }, fuzzTestTimeout())

  it('keeps every letter and digit of the content, in order', async () => {
    await fc.assert(
      clipboardProperty((html, plainText) => {
        const result = convertClipboardHtml(html, plainText)
        if (result.kind === 'plain') return
        const blocks = result.kind === 'inline' ? [result.markdown] : documentOrder(result.blocks)
        expect(unmatched(alphanumerics(contentText(html)), blocks.map(shownText).join('\n'))).toBe('')
      }),
      fuzzParams(150),
    )
  }, fuzzTestTimeout())
})
