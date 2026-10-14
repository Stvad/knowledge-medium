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

/** What the browser put in `text/plain` beside the html, where a test
 *  doesn't care: present, and carrying no outliner references. */
const PLAIN_TEXT = 'copied text'
const convert = (html: string, plainText = PLAIN_TEXT) => convertClipboardHtml(html, plainText)

/** The converted outline as content lines, each indented two spaces per
 *  level (only a block's FIRST line — a multi-line block's later lines are
 *  its content verbatim). */
const outline = (html: string): string[] => {
  const result = convert(html)
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

  it('keeps the selection\'s edge spaces on an inline paste', () => {
    expect(convert('<strong>bold</strong> ', 'bold ')).toEqual({kind: 'inline', markdown: '**bold** '})
    expect(convert(' <a href="https://e.com/">x</a>', ' x')).toEqual({kind: 'inline', markdown: ' [x](https://e.com/)'})
  })

  it('a single link selection is inline markdown', () => {
    expect(convert(chromePartialLink))
      .toEqual({kind: 'inline', markdown: '[the article](https://example.com/article)'})
  })

  it('keeps a lone web or chat code block whole, with its language', () => {
    const code = 'const a = 1\n# not a heading\n- nor a bullet'
    expect(outline(`<pre><code class="language-js">${code}</code></pre>`)).toEqual([`\`\`\`js\n${code}\n\`\`\``])
  })

  const deferring = [
    ['Chrome copying words of a heading (computed bold is not emphasis)', chromePartialHeading],
    ['a single spreadsheet cell', googleSheetsCell],
    ['VS Code (styled divs, no structure)', vscode],
    ['JetBrains (one <pre>)', jetbrains],
  ]

  it.each(deferring)('defers to the plain text for %s', (_, html) => {
    expect(convert(html)).toEqual(plain)
  })

  // Windows browsers hand over the clipboard's HTML format with its markers.
  const windowsClipboard = (html: string) =>
    `<html>\r\n<body>\r\n<!--StartFragment-->${html}<!--EndFragment-->\r\n</body>\r\n</html>`

  it.each(deferring)('defers to the plain text for %s, from a Windows clipboard', (_, html) => {
    expect(convert(windowsClipboard(html))).toEqual(plain)
  })
})

describe('convertClipboardHtml: outliner copies', () => {
  const html = '<h2>Notes</h2><p>See <code>if ((ready))</code></p><pre><code>m[[i]] = ((a1b2c3d4e))</code></pre>'

  it('defers to plain text carrying page or block references', () => {
    expect(convertClipboardHtml(html, 'Notes\nSee [[Page]]')).toEqual(plain)
    expect(convertClipboardHtml(html, 'Notes\n((z9y8x7w6v)) and more')).toEqual(plain)
    expect(convertClipboardHtml(html, 'ref ((123e4567-e89b-12d3-a456-426614174000))')).toEqual(plain)
  })

  it('reads balanced page aliases as the app\'s reference parser does', () => {
    expect(convert(html, 'See [[Book of [x]]]')).toEqual(plain)
  })

  it('reads uppercase UUIDs as block references, as the app does', () => {
    expect(convert(html, 'ref ((123E4567-E89B-12D3-A456-426614174000))')).toEqual(plain)
  })

  it('counts a reference used both in code and in prose as prose', () => {
    expect(convert('<p>See Page</p><pre><code>[[Page]]</code></pre>', 'See [[Page]]\nexample: [[Page]]')).toEqual(plain)
  })

  it('ignores reference-like syntax that is code, or not a block id', () => {
    const plainText = 'Notes\nSee if ((ready))\nm[[i]] = ((a1b2c3d4e))\ncall((x))'
    expect(convertClipboardHtml(html, plainText).kind).toBe('outline')
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

  it('converts an html-only clipboard even when it is plain paragraphs', () => {
    expect(convert('<p>hello</p>', '')).toEqual({kind: 'inline', markdown: 'hello'})
    expect(convert('<p>a</p><p>b</p>', '')).toMatchObject({kind: 'outline', blocks: [{content: 'a'}, {content: 'b'}]})
  })

  it('keeps a task item\'s checkbox state, as a markdown-text paste does', () => {
    expect(outline('<ul><li><input type="checkbox" checked>done</li><li><input type="checkbox">open</li></ul>'))
      .toEqual(['[x] done', '[ ] open'])
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
    expect(convert('<p>one<br><br><br>two</p>')).toEqual(plain)
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

  it('drops code-block chrome that sits beside the <code>', () => {
    expect(outline('<h1>T</h1><pre><span>javascript</span><button>Copy</button><code class="language-js">x = 1</code></pre>'))
      .toEqual(['# T', '  ```js\nx = 1\n```'])
  })

  it('keeps every line of a <pre> split across several <code>s', () => {
    expect(outline('<h1>T</h1><pre><code>a</code>\n<code>b</code></pre>')).toEqual(['# T', '  ```\na\nb\n```'])
  })

  it('writes a quote that a later text paste reads back as one block', () => {
    const [, quote] = outline('<h1>T</h1><blockquote><p>q1</p><p>q2</p></blockquote>')
    expect(parseMarkdownToBlocks(quote.trim()).map(block => block.content)).toEqual([quote.trim()])
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

  it('keeps whitespace at the edges of inline markup outside it', () => {
    expect(outline('<h1>T</h1><p><b>Note: </b>text</p><p>a<em> word</em></p><p>Hello<b> </b>world</p>'))
      .toEqual(['# T', '  **Note:** text', '  a *word*', '  Hello world'])
  })

  it('unwraps markup and links left with nothing in them', () => {
    expect(outline('<h1>T</h1><p><i class="icon"></i> Done <b>x</b><s></s></p>')).toEqual(['# T', '  Done **x**'])
    // A heading's icon-only anchor link, as on GitHub.
    expect(outline(
      '<div><h2>Install</h2><a href="https://github.com/o/r#install"><svg><path/></svg></a></div><ul><li>npm i</li></ul>',
    )).toEqual(['## Install', '  npm i'])
  })

  it('unwraps markup nested in the same markup', () => {
    expect(outline('<h1>T</h1><p><del><a href="#x"><del>struck</del></a></del> <b>a <i><b>b</b></i></b></p>'))
      .toEqual(['# T', '  ~~struck~~ **a *b***'])
  })

  it('makes no block of block markup nested in inline markup with no text', () => {
    expect(outline('<h1>T</h1><b><h2></h2></b><i><hr></i><p>end</p>')).toEqual(['# T', '  end'])
  })

  it('reads non-breaking spaces as spaces before collapsing whitespace', () => {
    expect(outline('<h1>T</h1><p>One</p><p>&nbsp;</p><p>&nbsp;Two&nbsp;</p><p>three&nbsp;<br>four</p>'))
      .toEqual(['# T', '  One', '  Two', '  three\nfour'])
  })

  it('ignores HTML comments', () => {
    expect(outline('<h1>T</h1><p><b>x</b><!--[if !supportLists]-->y</p>')).toEqual(['# T', '  **x**y'])
  })

  it('flattens block content in a table cell onto its row, and keeps the caption', () => {
    expect(outline(
      '<table><caption>Scores</caption><tr><th><h3>Name</h3></th><th>Notes</th></tr>' +
      '<tr><td><p>first</p><p>second</p></td><td><ul><li>x</li><li>y</li></ul></td></tr></table>',
    )).toEqual(['Scores', '| Name         | Notes |\n| ------------ | ----- |\n| first second | x y   |'])
  })

  it('defers to the plain text rather than drop text the converter cannot read', () => {
    expect(convert('<h1>T</h1><p>Energy <math><mi>E</mi></math> is <b>famous</b></p>')).toEqual(plain)
  })

  it('drops embeds, icons and form controls, which the plain text leaves out too', () => {
    expect(outline(
      '<h1>T</h1><p>a<svg><text>label</text></svg> <input placeholder="Search"><select><option>A</option></select></p>' +
      '<iframe src="about:blank" title="Video player"></iframe>',
    )).toEqual(['# T', '  a'])
  })

  it('keeps line breaks that the source draws with a white-space style', () => {
    expect(outline('<h1>T</h1><div style="white-space: pre-wrap;">Line one\nLine two</div>'))
      .toEqual(['# T', '  Line one\nLine two'])
  })

  it('defers to a multi-line plain text that the html runs into one line', () => {
    expect(convert('<span style="display:block">First</span><span style="display:block"><b>Second</b></span>', 'First\nSecond'))
      .toEqual(plain)
  })

  it('pastes an emoji image as its character', () => {
    expect(convert('<p>Nice <img alt="👍" src="https://e.com/emoji/1f44d.svg"> <b>work</b></p>'))
      .toEqual({kind: 'inline', markdown: 'Nice 👍 **work**'})
  })

  it('keeps a blockquote as one block', () => {
    expect(outline('<h1>T</h1><blockquote><p>q1</p><p>q2</p></blockquote>')).toEqual(['# T', '  > q1\n>\n> q2'])
  })
})
