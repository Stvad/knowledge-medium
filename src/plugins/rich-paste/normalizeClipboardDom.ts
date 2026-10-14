// Repairs clipboard HTML in place before it is converted to markdown: the
// quirks of specific sources, and HTML shapes the generic converter
// (`hast-util-to-mdast`) would mis-structure.

/** Page machinery, UI chrome (controls, icons, embeds), and MediaWiki
 *  (Wikipedia) citation markers, which would paste as bare `[1]`s with their
 *  footnotes left behind. A checkbox stays: it marks a task item. */
const NON_CONTENT = 'script, style, noscript, template, meta, link, title, button, select, ' +
  'input:not([type=checkbox]), svg, iframe, sup.reference'

export const normalizeClipboardDom = (body: HTMLElement): void => {
  for (const element of body.querySelectorAll(NON_CONTENT)) element.remove()
  normalizeText(body)
  emojiImagesToText(body)
  normalizeGoogleDocs(body)
  nestStrayLists(body)
  normalizeTables(body)
  keepOnlyCodeInPre(body)
}

/** `white-space` values under which a newline in the text is a line break.
 *  Not `pre`: that is a code view's, whose plain text is the better source. */
const KEEPS_LINE_BREAKS = /white-space\s*:\s*(pre-wrap|pre-line|break-spaces)/i

/** In place, before the converter collapses whitespace: comments go (Windows
 *  browsers wrap the clipboard's HTML in `<!--StartFragment-->` markers), a
 *  non-breaking space is a space, zero-width characters go, and a newline the
 *  source styles as a line break becomes a `<br>`. */
const normalizeText = (node: Node): void => {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === Node.COMMENT_NODE) child.remove()
    else if (child.nodeType !== Node.TEXT_NODE) normalizeText(child)
    else {
      const text = child.textContent!.replace(/\u00a0/g, ' ').replace(/[\u200b\ufeff]/g, '')
      const styled = child.parentElement?.closest('[style*="white-space"]')
      if (!KEEPS_LINE_BREAKS.test(styled?.getAttribute('style') ?? '')) child.textContent = text
      else child.replaceWith(...text.split('\n').flatMap((line, i) => i === 0 ? [line] : [lineBreak(child), line]))
    }
  }
}

const lineBreak = (node: Node): HTMLBRElement => node.ownerDocument!.createElement('br')

/** Emoji drawn as images (X, Slack, Discord) are their `alt` character, not
 *  an image to embed. */
const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u200d|\ufe0f)+$/u

const emojiImagesToText = (body: HTMLElement): void => {
  for (const image of body.querySelectorAll('img[alt]')) {
    const alt = image.getAttribute('alt')!
    if (EMOJI.test(alt)) image.replaceWith(alt)
  }
}

/** Google Docs wraps the whole paste in this element. */
const GOOGLE_DOCS_WRAPPER = 'b[id^="docs-internal-guid-"]'

/** Google Docs marks formatting with inline styles on spans rather than
 *  `<b>`/`<i>`, and wraps everything in a `font-weight:normal` `<b>`, which a
 *  generic converter reads as "the whole document is bold" (and which also
 *  flattens its headings into one paragraph). Only applied to Google Docs
 *  content: elsewhere a styled span is usually Chrome recording the COMPUTED
 *  style of a partial selection — copying a few words of a heading yields a
 *  `font-weight:700` span — and bolding those would be wrong. */
const normalizeGoogleDocs = (body: HTMLElement): void => {
  const wrappers = body.querySelectorAll(GOOGLE_DOCS_WRAPPER)
  if (wrappers.length === 0) return
  for (const wrapper of wrappers) wrapper.replaceWith(...wrapper.childNodes)

  for (const span of body.querySelectorAll('span[style]')) {
    // A heading's own size/weight is its heading-ness, not emphasis.
    if (span.closest('h1, h2, h3, h4, h5, h6')) continue
    const style = span.getAttribute('style') ?? ''
    const marks = [
      /font-weight:\s*(bold|[6-9]00)/i.test(style) && 'strong',
      /font-style:\s*italic/i.test(style) && 'em',
      /text-decoration[^;]*line-through/i.test(style) && 'del',
    ].filter((mark): mark is string => typeof mark === 'string')
    for (const mark of marks) {
      const element = body.ownerDocument.createElement(mark)
      element.append(...span.childNodes)
      span.append(element)
    }
  }
}

/** Google Docs (and others) nest a sub-list as a direct child of its parent
 *  list rather than inside an `<li>`. That's invalid HTML, and the converter
 *  merges the following item into the sub-list. Move each stray list into the
 *  item before it, where it belongs (a leading one, the converter already
 *  wraps in an item of its own). */
const nestStrayLists = (body: HTMLElement): void => {
  const stray = body.querySelectorAll(':is(ul, ol) > :is(ul, ol)')
  for (const list of stray) {
    const previous = list.previousElementSibling
    if (previous?.tagName === 'LI') previous.append(list)
  }
}

/** Each cell's block content, flattened onto one line: a GFM row can't hold
 *  a paragraph break, a list or a heading. */
const CELL_BLOCKS = 'p, div, li, ul, ol, dl, dt, dd, h1, h2, h3, h4, h5, h6, pre, blockquote'

/** A single-cell "table" (one copied spreadsheet cell) is just its content.
 *  A caption, which the converter ignores, becomes the paragraph before its
 *  table. Cells are flattened, and a table with no header cells gets its
 *  first row promoted: GFM requires a header row, and the converter otherwise
 *  invents an empty one. */
const normalizeTables = (body: HTMLElement): void => {
  const doc = body.ownerDocument
  for (const table of body.querySelectorAll('table')) {
    for (const caption of table.querySelectorAll('caption')) {
      const paragraph = doc.createElement('p')
      paragraph.append(...caption.childNodes)
      table.before(paragraph)
    }
    const cells = table.querySelectorAll('td, th')
    if (cells.length === 1) {
      const paragraph = doc.createElement('p')
      paragraph.append(...cells[0].childNodes)
      table.replaceWith(paragraph)
      continue
    }
    for (const cell of cells) {
      // Innermost first, so each block is flattened before its parent.
      for (const block of [...cell.querySelectorAll(CELL_BLOCKS)].reverse()) {
        const separator = block.nextSibling ? [lineBreak(block)] : []
        block.replaceWith(...block.childNodes, ...separator)
      }
    }
    const firstRow = table.querySelector('tr')
    if (!firstRow || table.querySelector('thead') || firstRow.querySelector('th')) continue
    for (const cell of [...firstRow.children]) {
      if (cell.tagName !== 'TD') continue
      const header = doc.createElement('th')
      header.append(...cell.childNodes)
      cell.replaceWith(header)
    }
  }
}

/** Chat UIs (and many docs sites) put a language label and a "Copy" button
 *  inside the `<pre>`, beside or around the `<code>`. Keep just the code —
 *  unless there are several, which may each hold part of it. */
const keepOnlyCodeInPre = (body: HTMLElement): void => {
  for (const pre of body.querySelectorAll('pre')) {
    const codes = pre.querySelectorAll('code')
    if (codes.length === 1) pre.replaceChildren(codes[0])
  }
}
