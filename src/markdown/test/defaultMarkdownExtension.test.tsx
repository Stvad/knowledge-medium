// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Markdown from 'react-markdown'
import { afterEach, describe, expect, it } from 'vitest'
import type { Block } from '@/data/block'
import { gfmMarkdownExtension, isExternalHref } from '@/markdown/defaultMarkdownExtension.js'

const markdownConfig = gfmMarkdownExtension({
  block: {} as Block,
  blockContext: {},
  data: {content: '', references: [], workspaceId: ''},
})

const renderMarkdown = (content: string) => {
  if (!markdownConfig) throw new Error('Expected markdown config')

  return render(
    <Markdown
      remarkPlugins={markdownConfig.remarkPlugins}
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

  // The separator BETWEEN two quoted paragraphs is what draws the blank line
  // between them (preflight zeroes paragraph margins), exactly as it does for a
  // block's own top-level paragraphs. Only the edges are padding.
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
  // unmarked, unindented lines. The gutter and marker are restored in CSS
  // (`.markdown-content`); asserted here only as far as the DOM goes, which is
  // that the list survives as a real list rather than as text.
  it('drops every newline separator inside a list', () => {
    const {container} = renderMarkdown('1. one\n2. two')

    const list = container.querySelector('ol')
    expect([...list!.childNodes].map(node => node.nodeName)).toEqual(['LI', 'LI'])
  })

  it('drops the separator between an item and its nested list', () => {
    const {container} = renderMarkdown('- a\n  - nested')

    const item = container.querySelector('li')
    expect([...item!.childNodes].map(node => node.nodeName)).toEqual(['#text', 'UL'])
  })

  // Same rule as a multi-paragraph quote: preflight zeroes paragraph margins,
  // so this separator is what draws the blank line between the two paragraphs
  // of a loose item. Only the edges are padding.
  it('keeps the separator between two paragraphs of a loose list item', () => {
    const {container} = renderMarkdown('- first\n\n  second')

    const item = container.querySelector('li')
    expect([...item!.childNodes].map(node => node.nodeName))
      .toEqual(['P', '#text', 'P'])
  })

  // A separator is recognised by its block-level neighbours, never by being
  // whitespace: the space between two inline elements is authored text, and
  // the pretty-printer's newline is spelled identically to a soft line break.
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
