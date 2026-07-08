import {describe, expect, it} from 'vitest'

import {normalizeBlockMarkdownForHtml} from '../src/markdownHtml'
import {processBlockText} from '../src/textProcessing'
import {withOptionalProxy} from '../src/url'

const repoWithRefs = (refs: Record<string, string>) => ({
  block: (id: string) => ({
    load: async () => {
      if (!(id in refs)) throw new Error(`missing ${id}`)
      return {content: refs[id]}
    },
  }),
})

describe('social publisher text preprocessing', () => {
  it('prepares block text for platform character counts and posting', async () => {
    const repo = repoWithRefs({
      abc123: 'Referenced [[Deep Page]]',
    })

    const result = await processBlockText(
      'Before ![pic](https://img.test/a.jpg) ((abc123)) [Alias](https://example.com) #[[Hash Tag]] [[Page Name]] **bold** __italic__ ^^mark^^ ~~gone~~ `code` {{publish}}',
      repo,
    )

    expect(result).toEqual({
      text: 'Before Referenced #DeepPage https://example.com #HashTag #PageName bold italic mark gone code',
      mediaUrls: ['https://img.test/a.jpg'],
    })
  })

  it('drops missing block refs without leaving double spaces', async () => {
    const result = await processBlockText('hello ((missing1)) world', repoWithRefs({}))

    expect(result.text).toBe('hello world')
  })
})

describe('LessWrong markdown normalization', () => {
  it('keeps markdown while resolving Knowledge Medium-only references', async () => {
    const repo = repoWithRefs({
      abc123: '**nested**',
    })

    const normalized = await normalizeBlockMarkdownForHtml(
      '[[Page Name]] ((abc123)) {{button}} #[[Tag Name]]',
      repo,
    )

    expect(normalized).toBe('Page Name **nested**  Tag Name')
  })
})

describe('optional CORS proxy URL handling', () => {
  it('prefixes requests only when a proxy is configured', () => {
    expect(withOptionalProxy('https://api.example/path', '')).toBe('https://api.example/path')
    expect(withOptionalProxy('https://api.example/path', 'https://proxy.example/')).toBe(
      'https://proxy.example/https://api.example/path',
    )
  })
})
