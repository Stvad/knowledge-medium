import {afterEach, describe, expect, it, vi} from 'vitest'

import {normalizeBlockMarkdownForHtml} from '../src/markdownHtml'
import {postToTwitter} from '../src/platforms'
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

afterEach(() => {
  vi.unstubAllGlobals()
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

describe('Twitter publishing', () => {
  it('sends Buffer image assets in the list shape expected by createPost', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      if (String(body.query).includes('account { organizations')) {
        return Response.json({data: {account: {organizations: [{id: 'org1'}]}}})
      }
      if (String(body.query).includes('query GetChannels')) {
        return Response.json({data: {channels: [{id: 'channel1', name: 'X', service: 'twitter'}]}})
      }
      return Response.json({
        data: {
          createPost: {
            post: {
              id: 'post1',
              status: 'sent',
              externalLink: 'https://twitter.test/post1',
            },
          },
        },
      })
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    const result = await postToTwitter(
      [
        {
          id: 'first',
          raw: 'first',
          text: 'first',
          mediaUrls: ['https://images.test/first.jpg'],
        },
        {
          id: 'second',
          raw: 'second',
          text: 'second',
          mediaUrls: [],
        },
      ],
      {
        bufferToken: 'buffer-token-for-assets-test',
        blueskyHandle: '',
        blueskyAppPassword: null,
        lesswrongToken: null,
        corsProxyUrl: '',
      },
    )

    expect(result).toEqual({
      platform: 'twitter',
      success: true,
      url: 'https://twitter.test/post1',
    })

    const createPostRequest = fetchMock.mock.calls.at(-1)?.[1] as RequestInit
    const createPostBody = JSON.parse(String(createPostRequest.body))
    expect(createPostBody.variables.input.assets).toEqual([
      {
        image: {
          url: 'https://images.test/first.jpg',
          metadata: {altText: 'Image from Knowledge Medium'},
        },
      },
    ])
    expect(createPostBody.variables.input.metadata.twitter.thread).toEqual([
      {
        text: 'first',
        assets: [
          {
            image: {
              url: 'https://images.test/first.jpg',
              metadata: {altText: 'Image from Knowledge Medium'},
            },
          },
        ],
      },
      {text: 'second'},
    ])
  })
})
