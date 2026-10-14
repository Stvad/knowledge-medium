// @vitest-environment happy-dom
/**
 * Fuzz suite for `convertClipboardHtml` — see `src/test/fuzz.ts` for the
 * smoke/deep tier mechanics. It runs inside the paste handler on whatever
 * HTML another app put on the clipboard, so the oracle is totality over tag
 * soup: never throws, and an outline never contains a blank block (every
 * front-end branch skips content that renders to nothing).
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout } from '@/test/fuzz'
import type { OutlineNode } from '@/utils/markdownParser'
import { convertClipboardHtml } from '../htmlToOutline'

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
  fc.string({maxLength: 6}),
)
const htmlArb = fc.array(fc.oneof(openTagArb, closeTagArb, leafArb), {maxLength: 24}).map(parts => parts.join(''))

const blankBlocks = (nodes: readonly OutlineNode[]): string[] =>
  nodes.flatMap(node => [
    ...(node.content.trim() === '' ? [JSON.stringify(node.content)] : []),
    ...blankBlocks(node.children ?? []),
  ])

describe('convertClipboardHtml: tag soup', () => {
  it('never throws and never yields a blank block', () => {
    fc.assert(
      fc.property(htmlArb, fc.constantFrom('', 'copied text'), (html, plainText) => {
        const result = convertClipboardHtml(html, plainText)
        if (result.kind === 'outline') expect(blankBlocks(result.blocks)).toEqual([])
        if (result.kind === 'inline') expect(result.markdown.trim()).not.toBe('')
      }),
      fuzzParams(150),
    )
  }, fuzzTestTimeout())
})
