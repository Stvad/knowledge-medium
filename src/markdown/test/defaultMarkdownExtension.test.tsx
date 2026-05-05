import { cleanup, render, screen } from '@testing-library/react'
import Markdown from 'react-markdown'
import { afterEach, describe, expect, it } from 'vitest'
import type { Block } from '@/data/block'
import { gfmMarkdownExtension, isExternalHref } from '@/markdown/defaultMarkdownExtension.ts'

const markdownConfig = gfmMarkdownExtension({
  block: {} as Block,
  blockContext: {},
})

const renderMarkdown = (content: string) => {
  if (!markdownConfig) throw new Error('Expected markdown config')

  render(
    <Markdown
      remarkPlugins={markdownConfig.remarkPlugins}
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
})
