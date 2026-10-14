// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { parseMarkdownToBlocks, type OutlineNode } from '@/utils/markdownParser'
import { convertClipboardHtml, type ClipboardHtmlConversion } from '../htmlToOutline'
import chatgptAnswer from './fixtures/chatgpt-answer.html?raw'
import chromePartialHeading from './fixtures/chrome-partial-heading.html?raw'
import chromePartialLink from './fixtures/chrome-partial-link.html?raw'
import googleDocs from './fixtures/google-docs.html?raw'
import googleSheetsCell from './fixtures/google-sheets-cell.html?raw'
import googleSheetsRange from './fixtures/google-sheets-range.html?raw'
import jetbrains from './fixtures/jetbrains.html?raw'
import vscode from './fixtures/vscode.html?raw'
import wikipediaChrome from './fixtures/wikipedia-chrome.html?raw'

/** The converted outline as content lines, each indented two spaces per
 *  level (only a block's FIRST line — a multi-line block's later lines are
 *  its content verbatim). */
const outline = (html: string): string[] => {
  const result = convertClipboardHtml(html)
  if (result.kind !== 'outline') throw new Error(`expected an outline, got ${JSON.stringify(result)}`)
  const lines = (nodes: readonly OutlineNode[], depth: number): string[] =>
    nodes.flatMap(node => ['  '.repeat(depth) + node.content, ...lines(node.children ?? [], depth + 1)])
  return lines(result.blocks, 0)
}

const plain: ClipboardHtmlConversion = {kind: 'plain'}

describe('convertClipboardHtml: sources', () => {
  it('Google Docs: unwraps the bold wrapper, reads styled spans, nests the stray sub-list', () => {
    expect(outline(googleDocs)).toEqual([
      '# Project plan',
      '  This doc covers the **launch**, with an *optional* stretch goal and a ~~cut~~ feature. See [the spec](https://example.com/spec).',
      '  ## Milestones',
      '    Design review',
      '      Mockups',
      '    Beta',
      '    | Owner | Date  |\n| ----- | ----- |\n| Ana   | May 1 |',
    ])
  })

  it('a web article (Chrome): sections under headings, a list under its paragraph, links kept', () => {
    expect(outline(wikipediaChrome)).toEqual([
      '## History',
      '  **Foo** was founded in 1901 by [Jane Doe](https://en.wikipedia.org/wiki/Jane_Doe). Its notable products:',
      '    The *Widget*',
      // A relative link has nothing to point at once pasted: its text stays.
      '    A gadget with a relative link',
      '  It later moved to Ohio.',
    ])
  })

  it('a chat answer: code without the UI chrome, numbered list, nested list, table', () => {
    expect(outline(chatgptAnswer)).toEqual([
      '### Setup',
      '  Install the package:',
      '  ```bash\nnpm install foo\n```',
      '  Then:',
      '    1. Import it',
      '    2. Call `init()` with:',
      '      a **name**',
      '      an optional *timeout*',
      '  | Option | Default |\n| ------ | ------- |\n| debug  | `false` |',
      "  That's it.",
    ])
  })

  it('a spreadsheet range becomes one table block, its first row the header', () => {
    expect(outline(googleSheetsRange)).toEqual(['| Name | Score |\n| ---- | ----- |\n| Ann  | 7     |'])
  })

  it('a single link selection is inline markdown', () => {
    expect(convertClipboardHtml(chromePartialLink))
      .toEqual({kind: 'inline', markdown: '[the article](https://example.com/article)'})
  })

  it.each([
    ['Chrome copying words of a heading (computed bold is not emphasis)', chromePartialHeading],
    ['a single spreadsheet cell', googleSheetsCell],
    ['VS Code (styled divs, no structure)', vscode],
    ['JetBrains (one <pre>)', jetbrains],
  ])('defers to the plain text for %s', (_, html) => {
    expect(convertClipboardHtml(html)).toEqual(plain)
  })
})

describe('convertClipboardHtml: content', () => {
  it('keeps a <br> as a newline inside the block, but not in a heading', () => {
    expect(outline('<h2>Two<br>lines</h2><p>first<br>second</p>')).toEqual(['## Two lines', '  first\nsecond'])
  })

  it('escapes text that would otherwise read back as structure', () => {
    expect(outline('<h1>T</h1><p>- dash</p><p>1. num</p><p># hash</p><p>a<br>- b</p>')).toEqual([
      '# T',
      '  \\- dash',
      '  1\\. num',
      '  \\# hash',
      '  a\n\\- b',
    ])
  })

  it('drops images it cannot load later and unwraps links it cannot follow', () => {
    expect(outline(
      '<h1>T</h1><p><img src="data:image/png;base64,AAAA" alt="inline">' +
      '<img src="https://e.com/a.png" alt="kept" title="tip"> ' +
      '<a href="javascript:alert(1)">js</a> <a href="#top">top</a> <a href="mailto:a@b.c">mail</a></p>',
    )).toEqual(['# T', '  ![kept](https://e.com/a.png) js top [mail](mailto:a@b.c)'])
  })

  it('does not bold a Google Docs heading whose style is bold', () => {
    expect(outline(
      '<b style="font-weight:normal;" id="docs-internal-guid-1"><h2><span style="font-weight:700">Bold style</span></h2>' +
      '<p><span style="font-weight:700">emphasis</span></p></b>',
    )).toEqual(['## Bold style', '  **emphasis**'])
  })

  it('keeps a lone heading or list item as a block, with its marker', () => {
    expect(outline('<h2>Title</h2>')).toEqual(['## Title'])
    expect(outline('<ol start="3"><li>third</li></ol>')).toEqual(['3. third'])
  })

  it('keeps a line break inside one block even with no other markup', () => {
    expect(outline('<p>first<br>second</p>')).toEqual(['first\nsecond'])
  })

  it('splits paragraphs at a double line break', () => {
    expect(outline('<p>one<br>&nbsp;<br>two<br>three</p>')).toEqual(['one', 'two\nthree'])
    expect(outline('<ul><li>item<br><br>more</li></ul>')).toEqual(['item', '  more'])
    // Nothing but paragraph breaks left: the plain text says the same.
    expect(convertClipboardHtml('<p>one<br><br><br>two</p>')).toEqual(plain)
  })

  it('keeps a formatted paragraph with a line break as a block, not a caret insert', () => {
    expect(outline('<p><a href="https://e.com/">one</a><br>two</p>')).toEqual(['[one](https://e.com/)\ntwo'])
  })

  it('flattens a line break inside a table cell, which a GFM row cannot hold', () => {
    expect(outline('<table><tr><th>a</th></tr><tr><td>x<br>y</td></tr></table>')).toEqual(['| a   |\n| --- |\n| x y |'])
  })

  it('drops a table, quote or code block with nothing in it', () => {
    expect(outline('<h1>T</h1><table><thead></thead></table><table><tr><td> </td><td></td></tr><tr><td></td></tr></table>' +
      '<blockquote> </blockquote><pre><code></code></pre><p>end</p>')).toEqual(['# T', '  end'])
  })

  it('writes a table that a later text paste reads back as one block', () => {
    // Copying the block and pasting it again goes through the markdown parser.
    const [table] = outline('<table><tr><th>a|b</th><th>c</th></tr><tr><td>1</td><td>2</td></tr></table>')
    expect(table).toContain('a\\|b')
    expect(parseMarkdownToBlocks(table).map(block => block.content)).toEqual([table])
  })

  it('normalizes non-breaking and zero-width spaces', () => {
    expect(outline('<h1>T</h1><p>a&nbsp;b\u200bc</p>')).toEqual(['# T', '  a bc'])
  })

  it('keeps continuation paragraphs of a list item as its children', () => {
    expect(outline('<ol start="3"><li><p>first</p><p>more</p></li><li>second</li></ol>'))
      .toEqual(['3. first', '  more', '4. second'])
  })

  it('nests an item that holds only a sub-list under the item before it', () => {
    expect(outline('<ul><li>a</li><li><ul><li>a1</li></ul></li><li>b</li></ul>'))
      .toEqual(['a', '  a1', 'b'])
  })

  it('keeps the items of a stray sub-list that has no item before it', () => {
    expect(outline('<ul><ul><li>deep</li></ul><li>b</li></ul>')).toEqual(['deep', 'b'])
  })

  it('keeps a blockquote as one block', () => {
    expect(outline('<h1>T</h1><blockquote><p>q1</p><p>q2</p></blockquote>')).toEqual(['# T', '  > q1\n>\n> q2'])
  })
})
