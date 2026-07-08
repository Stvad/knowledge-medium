import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import type { Components } from 'react-markdown'
import type { Block } from '@/data/block'
import { useAppRuntime } from '@/extensions/runtimeContext'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import type { BlockContextType } from '@/types'
import { markdownExtensionsFacet, type MarkdownRenderContext } from '../extensions'
import { renderMarkdownHtml } from '../renderMarkdownHtml'

const testContext = (content: string): MarkdownRenderContext => ({
  block: {} as Block,
  blockContext: {} as BlockContextType,
  data: {content, references: [], workspaceId: 'ws-test'},
})

const customParagraph: Components['p'] = ({children}) =>
  createElement('p', {'data-custom-markdown': 'yes'}, children)

const RuntimeReadingParagraph: Components['p'] = ({children}) => {
  const runtime = useAppRuntime()
  const hasResolver = typeof runtime.read(markdownExtensionsFacet) === 'function'
  return createElement('p', {'data-runtime-context': hasResolver ? 'yes' : 'no'}, children)
}

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

  it('uses contributed markdown facets when runtime and context are supplied', () => {
    const runtime = resolveFacetRuntimeSync(
      markdownExtensionsFacet.of(() => ({
        components: {p: customParagraph},
      }), {source: 'test'}),
    )

    const html = renderMarkdownHtml('hello', {
      runtime,
      context: testContext('hello'),
    })

    expect(html).toContain('data-custom-markdown="yes"')
  })

  it('provides app runtime context to contributed app-mode components', () => {
    const runtime = resolveFacetRuntimeSync(
      markdownExtensionsFacet.of(() => ({
        components: {p: RuntimeReadingParagraph},
      }), {source: 'test'}),
    )

    const html = renderMarkdownHtml('hello', {
      runtime,
      context: testContext('hello'),
    })

    expect(html).toContain('data-runtime-context="yes"')
  })

  it('can force the minimal external profile even when runtime is supplied', () => {
    const runtime = resolveFacetRuntimeSync(
      markdownExtensionsFacet.of(() => ({
        components: {p: customParagraph},
      }), {source: 'test'}),
    )

    const html = renderMarkdownHtml('hello', {
      runtime,
      context: testContext('hello'),
      mode: 'external',
    })

    expect(html).toContain('<p>hello</p>')
    expect(html).not.toContain('data-custom-markdown')
  })

  it('requires runtime and context for explicit app mode', () => {
    expect(() => renderMarkdownHtml('hello', {mode: 'app'}))
      .toThrow('renderMarkdownHtml mode "app" requires runtime and context')
  })
})
