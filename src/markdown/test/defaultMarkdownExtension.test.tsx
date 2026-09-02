// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Markdown from 'react-markdown'
import { afterEach, describe, expect, it } from 'vitest'
import type { Block } from '@/data/block'
import { gfmMarkdownExtension, isExternalHref } from '@/markdown/defaultMarkdownExtension.js'
import { remarkBlockrefs } from '@/plugins/references/markdown/blockrefs/remark-blockrefs.js'
import { remarkTimestamps } from '@/plugins/video-player/remark-timestamps.js'
import type { PluggableList } from 'unified'

const markdownConfig = gfmMarkdownExtension({
  block: {} as Block,
  blockContext: {},
  data: {content: '', references: [], workspaceId: ''},
})

const renderMarkdown = (content: string, extraRemarkPlugins: PluggableList = []) => {
  if (!markdownConfig) throw new Error('Expected markdown config')

  return render(
    <Markdown
      remarkPlugins={[...markdownConfig.remarkPlugins ?? [], ...extraRemarkPlugins]}
      rehypePlugins={markdownConfig.rehypePlugins}
      components={markdownConfig.components}
    >
      {content}
    </Markdown>,
  )
}

afterEach(cleanup)

describe('gfm markdown extension', () => {
  it('opens external markdown links in a new tab', () => {
    renderMarkdown('[Example](https://example.com)')

    const link = screen.getByRole('link', {name: 'Example'})
    expect(link).toHaveAttribute('href', 'https://example.com')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'))
  })

  it('leaves internal markdown links in the current tab', () => {
    renderMarkdown('[Page](#/workspace/block)')

    const link = screen.getByRole('link', {name: 'Page'})
    expect(link).not.toHaveAttribute('target')
    expect(link).not.toHaveAttribute('rel')
  })

  it('detects only off-origin http links as external', () => {
    const baseHref = 'https://app.example/current'

    expect(isExternalHref('https://docs.example/page', baseHref)).toBe(true)
    expect(isExternalHref('//docs.example/page', baseHref)).toBe(true)
    expect(isExternalHref('https://app.example/other', baseHref)).toBe(false)
    expect(isExternalHref('/other', baseHref)).toBe(false)
    expect(isExternalHref('mailto:user@example.com', baseHref)).toBe(false)
  })

  // The block container renders with `white-space: pre-wrap`, so the "\n" text
  // nodes mdast-to-hast puts between a blockquote and its children would each
  // draw a blank line. Asserting on the DOM text nodes rather than on the
  // rendered text, which collapses them either way.
  it('drops the newline separators mdast-to-hast puts inside a blockquote', () => {
    const {container} = renderMarkdown('> quote')

    const blockquote = container.querySelector('blockquote')
    expect(blockquote).not.toBeNull()
    expect([...blockquote!.childNodes].map(node => node.nodeName)).toEqual(['P'])
  })

  // Raw HTML reaches the tree as a `raw` node rather than an element, and the
  // serializer pretty-prints around it exactly as it does around elements.
  it('drops the separators around raw html in a quote', () => {
    const {container} = renderMarkdown('> <div>x</div>')

    expect(container.querySelector('blockquote')?.textContent).toBe('<div>x</div>')
  })

  // The separator BETWEEN two quoted paragraphs is the blank line the author
  // wrote (preflight zeroes paragraph margins), exactly as at a block's top
  // level. Only the edges are the pretty-printer's.
  it('keeps the separator between two quoted paragraphs', () => {
    const {container} = renderMarkdown('> first\n>\n> second')

    const blockquote = container.querySelector('blockquote')
    expect([...blockquote!.childNodes].map(node => node.nodeName))
      .toEqual(['P', '#text', 'P'])
  })

  it('keeps a soft line break inside the quoted paragraph', () => {
    const {container} = renderMarkdown('> quote\n> more')

    expect(container.querySelector('blockquote > p')?.textContent).toBe('quote\nmore')
  })

  // A list is rendered by markers and indent, both of which preflight strips
  // off every `ul`/`ol` for the app's own chrome — so what a block showed was
  // unmarked, unindented lines. The gutter and marker are restored by CSS
  // keyed on this class; stamping it here rather than reaching down from the
  // container is what keeps an embedded block's own chrome list out of it.
  it('marks the lists markdown produced, keeping gfm\'s own marks', () => {
    const {container} = renderMarkdown('1. one\n\n- [ ] task')

    expect(container.querySelector('ol')?.className).toBe('markdown-list')
    expect(container.querySelector('ul')?.className)
      .toBe('contains-task-list markdown-list')
  })

  it('drops every newline separator inside a tight list', () => {
    const {container} = renderMarkdown('1. one\n2. two')

    const list = container.querySelector('ol')
    expect([...list!.childNodes].map(node => node.nodeName)).toEqual(['LI', 'LI'])
  })

  it('drops the separator between an item and its nested list', () => {
    const {container} = renderMarkdown('- a\n  - nested')

    const item = container.querySelector('li')
    expect([...item!.childNodes].map(node => node.nodeName)).toEqual(['#text', 'UL'])
  })

  // The author's blank line survives wherever they put it, and the tight cases
  // above are the contrast: same tags either side, no blank line in the source,
  // no blank line rendered. Preflight zeroes block margins, so this separator
  // is the only thing drawing it.
  it('keeps the separator between the paragraphs of a loose list item', () => {
    const {container} = renderMarkdown('- first\n\n  second')

    const item = container.querySelector('li')
    expect([...item!.childNodes].map(node => node.nodeName))
      .toEqual(['P', '#text', 'P'])
  })

  it('keeps the separator before a non-paragraph block of a loose list item', () => {
    const {container} = renderMarkdown('- first\n\n  > quoted')

    const item = container.querySelector('li')
    expect([...item!.childNodes].map(node => node.nodeName))
      .toEqual(['P', '#text', 'BLOCKQUOTE'])
  })

  it('keeps the separator between the rows of a loose list', () => {
    const {container} = renderMarkdown('- one\n\n- two')

    const list = container.querySelector('ul')
    expect([...list!.childNodes].map(node => node.nodeName))
      .toEqual(['LI', '#text', 'LI'])
  })

  // remark-gfm synthesizes the space after a task checkbox, so it carries no
  // source position either — but it is content, not layout. Whitespace only
  // reads as the pretty-printer's when it is a line break.
  it('keeps the space gfm synthesizes after a task checkbox', () => {
    const {container} = renderMarkdown('- [ ] task item')

    expect(container.querySelector('li')?.textContent).toBe(' task item')
  })

  // A remark plugin that splits a text node leaves unpositioned slices of its
  // own, so being unpositioned cannot be the whole test — what separates them
  // is that the serializer only pretty-prints between BLOCK children, while
  // these sit among inline siblings. Driving the real plugins, because the
  // claim is about what they emit.
  it('keeps an authored newline between two nodes a remark plugin split apart', () => {
    const {container} = renderMarkdown('0:30\n1:00', [remarkTimestamps])

    expect(container.textContent).toBe('0:30\n1:00')
  })

  it('keeps an authored newline between two block references', () => {
    const first = '550e8400-e29b-41d4-a716-446655440000'
    const second = '550e8400-e29b-41d4-a716-446655440001'
    const {container} = renderMarkdown(`((${first}))\n((${second}))`, [remarkBlockrefs])

    expect(container.textContent).toContain('\n')
  })

  // The same rule at a block's top level, which used to be exempt: two
  // paragraphs the author spaced keep their line, a list they ran straight on
  // from a paragraph does not get one invented for it.
  it('keeps a top-level separator the author wrote', () => {
    const {container} = renderMarkdown('para one\n\npara two')

    expect([...container.childNodes].map(node => node.nodeName))
      .toEqual(['P', '#text', 'P'])
  })

  it('drops a top-level separator the author did not write', () => {
    const {container} = renderMarkdown('text\n- item')

    expect([...container.childNodes].map(node => node.nodeName)).toEqual(['P', 'UL'])
  })

  // mdast-to-hast wraps footnote definitions in a `<section>` it generates, so
  // that element has no span of its own — but the author did write a blank
  // line before it, and its contents carry the lines proving it.
  it('keeps the separator before a generated footnotes section', () => {
    const {container} = renderMarkdown('text[^1]\n\n[^1]: note')

    expect([...container.childNodes].map(node => node.nodeName))
      .toEqual(['P', '#text', 'SECTION'])
  })

  // Authored whitespace has a source position; the pretty-printer's does not.
  // That is the whole distinction — the two are spelled identically, so a
  // content-based rule eats the space between two inline elements.
  it('keeps authored whitespace between two inline elements in a list item', () => {
    const {container} = renderMarkdown('- **bold** *italic*')

    expect(container.querySelector('li')?.textContent).toBe('bold italic')
  })

  it('keeps a soft line break between two inline elements in a list item', () => {
    const {container} = renderMarkdown('- **bold**\n  *italic*')

    expect(container.querySelector('li')?.textContent).toBe('bold\nitalic')
  })

  it('opens a fullscreen preview when an embedded image is clicked', async () => {
    const user = userEvent.setup()
    renderMarkdown('![A cat](https://example.com/cat.png)')

    const inlineImage = screen.getByAltText('A cat')
    expect(inlineImage).toHaveAttribute('src', 'https://example.com/cat.png')
    expect(screen.queryByRole('dialog')).toBeNull()

    await user.click(inlineImage)

    const dialog = await screen.findByRole('dialog')
    const previewImage = within(dialog).getByAltText('A cat')
    expect(previewImage).toHaveAttribute('src', 'https://example.com/cat.png')
    expect(within(dialog).getByRole('button', {name: /close image preview/i})).toBeInTheDocument()
  })

  it('closes the image preview when the close button is clicked', async () => {
    const user = userEvent.setup()
    renderMarkdown('![A cat](https://example.com/cat.png)')

    await user.click(screen.getByAltText('A cat'))

    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', {name: /close image preview/i}))

    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
