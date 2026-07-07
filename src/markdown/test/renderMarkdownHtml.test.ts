import { describe, expect, it } from 'vitest'
import { renderMarkdownHtml } from '../renderMarkdownHtml'

describe('renderMarkdownHtml', () => {
  it('renders GitHub-flavored markdown to a static HTML fragment', () => {
    expect(renderMarkdownHtml('**Launch**\n\n- one\n- two')).toContain('<strong>Launch</strong>')
    expect(renderMarkdownHtml('- [x] done')).toContain('type="checkbox"')
  })

  it('uses markdown link behavior from the shared GFM extension', () => {
    const html = renderMarkdownHtml('[OpenAI](https://openai.com)')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('omits React image preload hints from the fragment', () => {
    const html = renderMarkdownHtml('![alt](https://example.com/image.png)')
    expect(html).toContain('<img')
    expect(html).not.toContain('rel="preload"')
  })
})
