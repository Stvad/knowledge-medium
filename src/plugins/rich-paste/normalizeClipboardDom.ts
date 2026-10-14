// Repairs clipboard HTML in place before it is converted to markdown: the
// quirks of specific sources, and HTML shapes the generic converter
// (`hast-util-to-mdast`) would mis-structure.

/** Page machinery, UI chrome, and MediaWiki (Wikipedia) citation markers,
 *  which would paste as bare `[1]`s with their footnotes left behind. */
const NON_CONTENT = 'script, style, noscript, template, meta, link, title, button, sup.reference'

export const normalizeClipboardDom = (body: HTMLElement): void => {
  for (const element of body.querySelectorAll(NON_CONTENT)) element.remove()
  normalizeGoogleDocs(body)
  nestStrayLists(body)
  normalizeTables(body)
  keepOnlyCodeInPre(body)
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

/** A single-cell "table" (one copied spreadsheet cell) is just its content.
 *  A table with no header cells gets its first row promoted: GFM requires a
 *  header row, and the converter otherwise invents an empty one. */
const normalizeTables = (body: HTMLElement): void => {
  for (const table of body.querySelectorAll('table')) {
    const cells = table.querySelectorAll('td, th')
    if (cells.length === 1) {
      const paragraph = body.ownerDocument.createElement('p')
      paragraph.append(...cells[0].childNodes)
      table.replaceWith(paragraph)
      continue
    }
    const firstRow = table.querySelector('tr')
    if (!firstRow || table.querySelector('thead') || firstRow.querySelector('th')) continue
    for (const cell of [...firstRow.children]) {
      if (cell.tagName !== 'TD') continue
      const header = body.ownerDocument.createElement('th')
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
