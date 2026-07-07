import {
  actionsFacet,
  ActionContextTypes,
  blockContentDecoratorsFacet,
  ChangeScope,
  codecs,
  defineBlockType,
  defineProperty,
  definePropertyEditorOverride,
  getPluginPrefsBlock,
  navigate,
  openDialog,
  propertyEditorOverridesFacet,
  propertySchemasFacet,
  showError,
  showInfo,
  showPropertiesProp,
  showSuccess,
  typesFacet,
  type ActionConfig,
  type BlockContentDecorator,
  type BlockContentDecoratorContribution,
  type BlockRenderer,
  type DialogContextProps,
  type PropertyEditorProps,
} from '@/extensions/api.js'
import { dialogAppMountExtension } from '@/extensions/dialogAppMount.js'
import { gfmMarkdownExtension } from '@/markdown/defaultMarkdownExtension.js'
import { CHAR_COUNTER_TYPE } from '@/plugins/character-counter/blockType.js'
import { charLimitProp } from '@/plugins/character-counter/properties.js'
import { Button } from '@/components/ui/button.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.js'
import { Input } from '@/components/ui/input.js'
import { Label } from '@/components/ui/label.js'
import { renderToStaticMarkup } from 'react-dom/server'
import { useEffect, useMemo, useState, type CSSProperties, type SVGProps } from 'react'
import { AtpAgent, RichText } from 'https://esm.sh/@atproto/api@0.19.3?bundle'
import Markdown from 'https://esm.sh/react-markdown@10.1.0?bundle&external=react'

const source = 'social-media-publisher'
const BUFFER_TOKEN_KEY = 'knowledge-medium:social-publisher:buffer-token:v1'
const BLUESKY_APP_PASSWORD_KEY = 'knowledge-medium:social-publisher:bluesky-app-password:v1'
const LESSWRONG_TOKEN_KEY = 'knowledge-medium:social-publisher:lesswrong-token:v1'

const TWITTER_CHAR_LIMIT = 280
const BLUESKY_CHAR_LIMIT = 300
const BUFFER_API_URL = 'https://api.buffer.com'
const BSKY_SERVICE_URL = 'https://bsky.social'
const LW_GRAPHQL_URL = 'https://www.lesswrong.com/graphql'

type PlatformId = 'twitter' | 'bluesky' | 'lesswrong'
type TargetPlatform = PlatformId | 'all'

interface PostBlock {
  id: string
  content: string
}

interface ProcessedBlock {
  id: string
  raw: string
  text: string
  mediaUrls: string[]
}

interface PlatformConfig {
  bufferToken: string | null
  blueskyHandle: string
  blueskyAppPassword: string | null
  lesswrongToken: string | null
  corsProxyUrl: string
}

interface PostResult {
  platform: PlatformId
  success: boolean
  url?: string
  error?: string
}

const PLATFORM_LABELS: Record<PlatformId, string> = {
  twitter: 'X / Twitter',
  bluesky: 'Bluesky',
  lesswrong: 'LessWrong',
}

const PLATFORM_SHORT_LABELS: Record<PlatformId, string> = {
  twitter: 'X',
  bluesky: 'Bluesky',
  lesswrong: 'LW',
}

const IconBase = ({children, ...props}: SVGProps<SVGSVGElement>) => (
  <svg
    xmlns='http://www.w3.org/2000/svg'
    viewBox='0 0 24 24'
    fill='none'
    stroke='currentColor'
    strokeWidth='2'
    strokeLinecap='round'
    strokeLinejoin='round'
    aria-hidden='true'
    {...props}
  >
    {children}
  </svg>
)

const SendIcon = (props: SVGProps<SVGSVGElement>) => (
  <IconBase {...props}>
    <path d='m22 2-7 20-4-9-9-4Z' />
    <path d='M22 2 11 13' />
  </IconBase>
)

const SettingsIcon = (props: SVGProps<SVGSVGElement>) => (
  <IconBase {...props}>
    <path d='M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.72l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z' />
    <circle cx='12' cy='12' r='3' />
  </IconBase>
)

const CheckCircleIcon = (props: SVGProps<SVGSVGElement>) => (
  <IconBase {...props}>
    <circle cx='12' cy='12' r='10' />
    <path d='m9 12 2 2 4-4' />
  </IconBase>
)

const AlertCircleIcon = (props: SVGProps<SVGSVGElement>) => (
  <IconBase {...props}>
    <circle cx='12' cy='12' r='10' />
    <path d='M12 8v4' />
    <path d='M12 16h.01' />
  </IconBase>
)

const ExternalLinkIcon = (props: SVGProps<SVGSVGElement>) => (
  <IconBase {...props}>
    <path d='M15 3h6v6' />
    <path d='M10 14 21 3' />
    <path d='M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' />
  </IconBase>
)

const blueskyHandleProp = defineProperty<string>('socialPublisher:blueskyHandle', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.UserPrefs,
})
const corsProxyUrlProp = defineProperty<string>('socialPublisher:corsProxyUrl', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.UserPrefs,
})
const twitterConnectedHintProp = defineProperty<boolean>('socialPublisher:twitterConfigured', {
  codec: codecs.boolean,
  defaultValue: false,
  changeScope: ChangeScope.UserPrefs,
})
const blueskyConnectedHintProp = defineProperty<boolean>('socialPublisher:blueskyConfigured', {
  codec: codecs.boolean,
  defaultValue: false,
  changeScope: ChangeScope.UserPrefs,
})
const lesswrongConnectedHintProp = defineProperty<boolean>('socialPublisher:lesswrongConfigured', {
  codec: codecs.boolean,
  defaultValue: false,
  changeScope: ChangeScope.UserPrefs,
})

const publisherPrefsType = defineBlockType({
  id: 'social-publisher-prefs',
  label: 'Social Publisher',
  hideFromCompletion: true,
  properties: [
    blueskyHandleProp,
    corsProxyUrlProp,
    twitterConnectedHintProp,
    blueskyConnectedHintProp,
    lesswrongConnectedHintProp,
  ],
})

const publishAllType = defineBlockType({
  id: 'social-publisher-publish',
  label: 'Social publish',
  description: 'Command block: publish child blocks to configured social platforms.',
})
const publishTwitterType = defineBlockType({
  id: 'social-publisher-twitter',
  label: 'Social publish: X / Twitter',
  description: 'Command block: publish child blocks to X / Twitter via Buffer.',
})
const publishBlueskyType = defineBlockType({
  id: 'social-publisher-bluesky',
  label: 'Social publish: Bluesky',
  description: 'Command block: publish child blocks to Bluesky.',
})
const publishLessWrongType = defineBlockType({
  id: 'social-publisher-lesswrong',
  label: 'Social publish: LessWrong',
  description: 'Command block: publish child blocks to LessWrong shortform.',
})

const commandTypes = [
  {type: publishAllType, target: 'all' as const},
  {type: publishTwitterType, target: 'twitter' as const},
  {type: publishBlueskyType, target: 'bluesky' as const},
  {type: publishLessWrongType, target: 'lesswrong' as const},
] as const

const loadBufferToken = (): string | null => window.localStorage.getItem(BUFFER_TOKEN_KEY)
const saveBufferToken = (value: string): void =>
  window.localStorage.setItem('knowledge-medium:social-publisher:buffer-token:v1', value)
const clearBufferToken = (): void => window.localStorage.removeItem(BUFFER_TOKEN_KEY)

const loadBlueskyAppPassword = (): string | null =>
  window.localStorage.getItem(BLUESKY_APP_PASSWORD_KEY)
const saveBlueskyAppPassword = (value: string): void =>
  window.localStorage.setItem('knowledge-medium:social-publisher:bluesky-app-password:v1', value)
const clearBlueskyAppPassword = (): void =>
  window.localStorage.removeItem(BLUESKY_APP_PASSWORD_KEY)

const loadLessWrongToken = (): string | null => window.localStorage.getItem(LESSWRONG_TOKEN_KEY)
const saveLessWrongToken = (value: string): void =>
  window.localStorage.setItem('knowledge-medium:social-publisher:lesswrong-token:v1', value)
const clearLessWrongToken = (): void => window.localStorage.removeItem(LESSWRONG_TOKEN_KEY)

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '')

const withOptionalProxy = (url: string, proxyUrl: string): string => {
  const proxy = trimTrailingSlash(proxyUrl.trim())
  return proxy ? `${proxy}/${url}` : url
}

const prefsBlock = async (repo: any) => {
  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId) return null
  return getPluginPrefsBlock(repo, workspaceId, repo.user, publisherPrefsType)
}

const loadConfig = async (repo: any): Promise<PlatformConfig> => {
  const prefs = await prefsBlock(repo)
  const blueskyHandle = prefs?.peekProperty(blueskyHandleProp) ?? ''
  const corsProxyUrl = prefs?.peekProperty(corsProxyUrlProp) ?? ''
  return {
    bufferToken: loadBufferToken(),
    blueskyHandle,
    blueskyAppPassword: loadBlueskyAppPassword(),
    lesswrongToken: loadLessWrongToken(),
    corsProxyUrl,
  }
}

const updateCredentialHints = async (repo: any): Promise<void> => {
  const prefs = await prefsBlock(repo)
  if (!prefs) return
  const blueskyHandle = prefs.peekProperty(blueskyHandleProp) ?? ''
  await prefs.set(twitterConnectedHintProp, Boolean(loadBufferToken()))
  await prefs.set(
    blueskyConnectedHintProp,
    Boolean(blueskyHandle && loadBlueskyAppPassword()),
  )
  await prefs.set(lesswrongConnectedHintProp, Boolean(loadLessWrongToken()))
}

const configuredPlatforms = (config: PlatformConfig): PlatformId[] => {
  const platforms: PlatformId[] = []
  if (config.bufferToken) platforms.push('twitter')
  if (config.blueskyHandle && config.blueskyAppPassword) platforms.push('bluesky')
  if (config.lesswrongToken) platforms.push('lesswrong')
  return platforms
}

const platformsForTarget = (target: TargetPlatform, config: PlatformConfig): PlatformId[] =>
  target === 'all' ? configuredPlatforms(config) : [target]

const BLOCK_REF_REGEX = /\(\(([\w\d-]{6,64})\)\)/g
const PAGE_REF_REGEX = /\[\[([^\]]+)\]\]/g
const HASHTAG_PAGE_REF_REGEX = /#\[\[([^\]]+)\]\]/g
const IMAGE_REGEX = /!\[[^\]]*\]\(([^\s)]*)\)/g
const ALIAS_REGEX = /\[([^\]]*)\]\(([^)]+)\)/g
const BUTTON_REGEX = /\{\{[^}]*\}\}/g
const BOLD_REGEX = /\*\*(.+?)\*\*/g
const ITALIC_REGEX = /__(.+?)__/g
const HIGHLIGHT_REGEX = /\^\^(.+?)\^\^/g
const STRIKETHROUGH_REGEX = /~~(.+?)~~/g
const INLINE_CODE_REGEX = /`([^`]+)`/g

const replaceAsync = async (
  input: string,
  regex: RegExp,
  replacer: (...args: any[]) => Promise<string>,
): Promise<string> => {
  const matches = Array.from(input.matchAll(regex))
  if (matches.length === 0) return input
  const replacements = await Promise.all(matches.map(match => replacer(...match)))
  let offset = 0
  let result = input
  matches.forEach((match, index) => {
    const start = (match.index ?? 0) + offset
    const end = start + match[0].length
    result = `${result.slice(0, start)}${replacements[index]}${result.slice(end)}`
    offset += replacements[index].length - match[0].length
  })
  return result
}

const resolveBlockReference = async (repo: any, id: string): Promise<string> => {
  try {
    const data = await repo.block(id).load()
    return data?.content ?? ''
  } catch {
    return ''
  }
}

const processBlockText = async (raw: string, repo: any): Promise<Omit<ProcessedBlock, 'id' | 'raw'>> => {
  let text = raw
  const mediaUrls: string[] = []

  text = text.replace(IMAGE_REGEX, (_match, url) => {
    mediaUrls.push(url)
    return ''
  })

  text = await replaceAsync(text, BLOCK_REF_REGEX, async (_match, id) =>
    resolveBlockReference(repo, id))

  text = text.replace(ALIAS_REGEX, '$2')
  text = text.replace(HASHTAG_PAGE_REF_REGEX, (_match, pageName) =>
    `#${String(pageName).replace(/\s+/g, '')}`)
  text = text.replace(PAGE_REF_REGEX, (_match, pageName) =>
    `#${String(pageName).replace(/\s+/g, '')}`)
  text = text.replace(BOLD_REGEX, '$1')
  text = text.replace(ITALIC_REGEX, '$1')
  text = text.replace(HIGHLIGHT_REGEX, '$1')
  text = text.replace(STRIKETHROUGH_REGEX, '$1')
  text = text.replace(INLINE_CODE_REGEX, '$1')
  text = text.replace(BUTTON_REGEX, '')
  text = text.replace(/  +/g, ' ').trim()

  return {text, mediaUrls}
}

const processBlocks = async (blocks: PostBlock[], repo: any): Promise<ProcessedBlock[]> =>
  Promise.all(blocks.map(async block => ({
    id: block.id,
    raw: block.content,
    ...(await processBlockText(block.content, repo)),
  })))

const graphemeLength = (text: string): number => {
  const Segmenter = Intl.Segmenter
  if (Segmenter) {
    const segmenter = new Segmenter(undefined, {granularity: 'grapheme'})
    return Array.from(segmenter.segment(text)).length
  }
  return [...text].length
}

const validateThread = (
  blocks: ProcessedBlock[],
  platform: PlatformId,
): string[] => {
  if (platform === 'lesswrong') return []
  const limit = platform === 'twitter' ? TWITTER_CHAR_LIMIT : BLUESKY_CHAR_LIMIT
  return blocks.flatMap((block, index) => {
    const count = platform === 'bluesky' ? graphemeLength(block.text) : block.text.length
    if (!block.text && block.mediaUrls.length === 0) return [`Post ${index + 1} is empty`]
    if (count > limit) return [`Post ${index + 1} is ${count - limit} chars over ${PLATFORM_LABELS[platform]}'s limit`]
    return []
  })
}

const staticMarkdownContext = (content: string) => ({
  block: {} as any,
  blockContext: {},
  data: {content, references: [], workspaceId: ''},
})

const StaticMarkdownImage = ({node: _node, ...props}: any) => {
  void _node
  return <img {...props} />
}

const stripReactResourceHints = (html: string): string =>
  html.replace(/<link rel="preload" as="image" href="[^"]*"\/>/g, '')

const renderMarkdownHtml = (content: string): string => {
  const gfmConfig = gfmMarkdownExtension(staticMarkdownContext(content)) || {}
  return stripReactResourceHints(renderToStaticMarkup(
    <Markdown
      remarkPlugins={gfmConfig.remarkPlugins}
      components={{
        ...gfmConfig.components,
        img: StaticMarkdownImage,
      }}
    >
      {content}
    </Markdown>,
  ))
}

const normalizeBlockMarkdownForHtml = async (raw: string, repo: any): Promise<string> => {
  let text = raw

  text = await replaceAsync(text, BLOCK_REF_REGEX, async (_match, id) =>
    resolveBlockReference(repo, id))
  text = text.replace(BUTTON_REGEX, '')
  text = text.replace(HASHTAG_PAGE_REF_REGEX, (_match, pageName) => String(pageName))
  text = text.replace(PAGE_REF_REGEX, (_match, pageName) => String(pageName))
  return text.trim()
}

const blockToHtml = async (raw: string, repo: any): Promise<string> => {
  const markdown = await normalizeBlockMarkdownForHtml(raw, repo)
  return markdown ? renderMarkdownHtml(markdown) : ''
}

const blocksToHtml = async (blocks: PostBlock[], repo: any): Promise<string> => {
  const htmlBlocks = await Promise.all(blocks.map(async block => {
    return blockToHtml(block.content, repo)
  }))
  return htmlBlocks.filter(Boolean).join('\n')
}

let cachedBufferChannelId: {token: string; channelId: string} | null = null

const bufferGraphQL = async (
  apiToken: string,
  corsProxyUrl: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<any> => {
  const response = await fetch(withOptionalProxy(BUFFER_API_URL, corsProxyUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiToken}`,
    },
    body: JSON.stringify({query, variables}),
  })
  if (!response.ok) throw new Error(`Buffer API HTTP ${response.status}: ${response.statusText}`)
  const result = await response.json()
  if (result.errors?.length) {
    throw new Error(result.errors.map((error: {message: string}) => error.message).join(', '))
  }
  return result.data
}

const resolveTwitterChannelId = async (
  apiToken: string,
  corsProxyUrl: string,
): Promise<string> => {
  if (cachedBufferChannelId?.token === apiToken) return cachedBufferChannelId.channelId
  const orgData = await bufferGraphQL(apiToken, corsProxyUrl, '{ account { organizations { id } } }')
  const organizationId = orgData.account?.organizations?.[0]?.id
  if (!organizationId) throw new Error('No Buffer organizations found')

  const channelData = await bufferGraphQL(
    apiToken,
    corsProxyUrl,
    'query GetChannels($input: ChannelsInput!) { channels(input: $input) { id name service } }',
    {input: {organizationId}},
  )
  const twitterChannel = channelData.channels?.find((channel: {service: string}) =>
    channel.service === 'twitter')
  if (!twitterChannel) throw new Error('No Twitter/X channel found in Buffer')

  cachedBufferChannelId = {token: apiToken, channelId: twitterChannel.id}
  return twitterChannel.id
}

const postToTwitter = async (
  blocks: ProcessedBlock[],
  config: PlatformConfig,
): Promise<PostResult> => {
  if (!config.bufferToken) {
    return {platform: 'twitter', success: false, error: 'Buffer API token is not configured'}
  }

  const postable = blocks.filter(block => block.text || block.mediaUrls.length)
  if (postable.length === 0) return {platform: 'twitter', success: false, error: 'No content to post'}

  try {
    const channelId = await resolveTwitterChannelId(config.bufferToken, config.corsProxyUrl)
    const buildAssets = (mediaUrls: string[]) =>
      mediaUrls.slice(0, 4).map(url => ({
        image: {
          url,
          metadata: {altText: 'Image from Knowledge Medium'},
        },
      }))

    const input: Record<string, unknown> = {
      text: postable[0].text,
      channelId,
      schedulingType: 'automatic',
      mode: 'shareNow',
      assets: buildAssets(postable[0].mediaUrls),
    }

    if (postable.length > 1) {
      input.metadata = {
        twitter: {
          thread: postable.map(block => ({
            text: block.text,
            assets: buildAssets(block.mediaUrls),
          })),
        },
      }
    }

    const data = await bufferGraphQL(
      config.bufferToken,
      config.corsProxyUrl,
      `mutation CreatePost($input: CreatePostInput!) {
        createPost(input: $input) {
          ... on PostActionSuccess { post { id status externalLink } }
          ... on MutationError { message }
        }
      }`,
      {input},
    )
    const result = data.createPost
    if (result.message) return {platform: 'twitter', success: false, error: result.message}
    return {platform: 'twitter', success: true, url: result.post?.externalLink}
  } catch (error) {
    return {
      platform: 'twitter',
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

const fetchImageAsBlob = async (url: string, corsProxyUrl: string): Promise<Blob> => {
  const response = await fetch(withOptionalProxy(url, corsProxyUrl))
  if (!response.ok) throw new Error(`Image fetch failed (${response.status})`)
  return response.blob()
}

const uploadBlueskyImages = async (
  mediaUrls: string[],
  agent: any,
  corsProxyUrl: string,
): Promise<unknown | null> => {
  if (mediaUrls.length === 0) return null
  const images = await Promise.all(mediaUrls.slice(0, 4).map(async url => {
    const blob = await fetchImageAsBlob(url, corsProxyUrl)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const {data} = await agent.uploadBlob(bytes, {
      encoding: blob.type || 'image/jpeg',
    })
    if (!data?.blob) throw new Error('Bluesky did not return an image blob reference')
    return {alt: 'Image from Knowledge Medium', image: data.blob}
  }))
  return {$type: 'app.bsky.embed.images', images}
}

const postToBluesky = async (
  blocks: ProcessedBlock[],
  config: PlatformConfig,
): Promise<PostResult> => {
  if (!config.blueskyHandle || !config.blueskyAppPassword) {
    return {platform: 'bluesky', success: false, error: 'Bluesky handle or app password is not configured'}
  }

  const postable = blocks.filter(block => block.text || block.mediaUrls.length)
  if (postable.length === 0) return {platform: 'bluesky', success: false, error: 'No content to post'}

  try {
    const agent = new AtpAgent({service: BSKY_SERVICE_URL})
    await agent.login({
      identifier: config.blueskyHandle,
      password: config.blueskyAppPassword,
    })

    let rootRef: {uri: string; cid: string} | undefined
    let parentRef: {uri: string; cid: string} | undefined
    let firstPostUrl: string | undefined

    for (const block of postable) {
      const richText = new RichText({text: block.text})
      await richText.detectFacets(agent)

      const record: Record<string, unknown> = {
        text: richText.text,
        facets: richText.facets,
        createdAt: new Date().toISOString(),
      }
      if (rootRef && parentRef) record.reply = {root: rootRef, parent: parentRef}
      const embed = await uploadBlueskyImages(block.mediaUrls, agent, config.corsProxyUrl)
      if (embed) record.embed = embed

      const created = await agent.api.app.bsky.feed.post.create(
        {repo: agent.session!.did},
        record,
      )
      const ref = {uri: created.uri, cid: created.cid}
      if (!rootRef) {
        rootRef = ref
        const rkey = String(created.uri).split('/').pop()
        firstPostUrl = `https://bsky.app/profile/${agent.session?.handle ?? config.blueskyHandle}/post/${rkey}`
      }
      parentRef = ref
    }

    return {platform: 'bluesky', success: true, url: firstPostUrl}
  } catch (error) {
    return {
      platform: 'bluesky',
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

const postToLessWrong = async (
  blocks: PostBlock[],
  repo: any,
  config: PlatformConfig,
): Promise<PostResult> => {
  if (!config.lesswrongToken) {
    return {platform: 'lesswrong', success: false, error: 'LessWrong login token is not configured'}
  }

  try {
    const html = await blocksToHtml(blocks, repo)
    if (!html.trim()) return {platform: 'lesswrong', success: false, error: 'No content to post'}

    const response = await fetch(withOptionalProxy(LW_GRAPHQL_URL, config.corsProxyUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        loginToken: config.lesswrongToken,
      },
      body: JSON.stringify({
        query: `mutation CreateComment($data: CreateCommentDataInput!) {
          createComment(data: $data) {
            data { _id postId user { slug } }
          }
        }`,
        variables: {
          data: {
            shortform: true,
            shortformFrontpage: true,
            contents: {
              originalContents: {type: 'html', data: html},
            },
          },
        },
      }),
    })
    if (!response.ok) return {platform: 'lesswrong', success: false, error: `HTTP ${response.status}`}
    const result = await response.json()
    if (result.errors?.length) {
      return {
        platform: 'lesswrong',
        success: false,
        error: result.errors.map((error: {message: string}) => error.message).join(', '),
      }
    }
    const userSlug = result.data?.createComment?.data?.user?.slug
    return {
      platform: 'lesswrong',
      success: true,
      url: userSlug ? `https://www.lesswrong.com/users/${userSlug}?tab=shortform` : undefined,
    }
  } catch (error) {
    return {
      platform: 'lesswrong',
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

const readChildBlocks = async (repo: any, blockId: string): Promise<PostBlock[]> => {
  const block = repo.block(blockId)
  await block.load()
  const children = await block.children.load()
  return children.map((child: {id: string; content: string}) => ({
    id: child.id,
    content: child.content ?? '',
  }))
}

const characterLimitForTarget = (
  target: TargetPlatform,
  config: PlatformConfig,
): number | undefined => {
  if (target === 'twitter') return TWITTER_CHAR_LIMIT
  if (target === 'bluesky') return BLUESKY_CHAR_LIMIT
  if (target === 'lesswrong') return undefined
  const platforms = configuredPlatforms(config)
  if (platforms.includes('twitter')) return TWITTER_CHAR_LIMIT
  if (platforms.includes('bluesky')) return BLUESKY_CHAR_LIMIT
  return undefined
}

const applyBuiltInCharacterCounters = async (
  repo: any,
  blocks: PostBlock[],
  limit: number | undefined,
): Promise<void> => {
  if (limit === undefined || blocks.length === 0) return
  const typeSnapshot = repo.snapshotTypeRegistries()
  await repo.tx(async (tx: any) => {
    for (const block of blocks) {
      await repo.addTypeInTx(tx, block.id, CHAR_COUNTER_TYPE, {}, typeSnapshot)
      await tx.setProperty(block.id, charLimitProp, limit)
    }
  }, {scope: ChangeScope.BlockDefault, description: 'social publisher character counters'})
}

const annotateParent = async (
  repo: any,
  blockId: string,
  results: PostResult[],
): Promise<void> => {
  const successResults = results.filter(result => result.success && result.url)
  if (successResults.length === 0) return
  const block = repo.block(blockId)
  const data = await block.load()
  const current = data?.content ?? ''
  const links = successResults
    .map(result => `[${PLATFORM_LABELS[result.platform]}](${result.url})`)
    .join(' ')
  const timestamp = new Date().toLocaleString()
  await block.setContent(`${current} (Posted ${timestamp}: ${links})`)
}

const countForPlatform = (block: ProcessedBlock, platform: PlatformId): number =>
  platform === 'bluesky' ? graphemeLength(block.text) : block.text.length

const postToPlatform = async (
  platform: PlatformId,
  processedBlocks: ProcessedBlock[],
  rawBlocks: PostBlock[],
  repo: any,
  config: PlatformConfig,
): Promise<PostResult> => {
  if (platform === 'twitter') return postToTwitter(processedBlocks, config)
  if (platform === 'bluesky') return postToBluesky(processedBlocks, config)
  return postToLessWrong(rawBlocks, repo, config)
}

const publishFromBlock = async (
  repo: any,
  blockId: string,
  target: TargetPlatform,
): Promise<void> => {
  await openDialog(PublishDialog, {repo, blockId, target})
}

interface PublishDialogProps {
  repo: any
  blockId: string
  target: TargetPlatform
}

const PublishDialog = ({
  repo,
  blockId,
  target,
  resolve,
  cancel,
}: DialogContextProps<boolean> & PublishDialogProps) => {
  const [rawBlocks, setRawBlocks] = useState<PostBlock[]>([])
  const [processedBlocks, setProcessedBlocks] = useState<ProcessedBlock[]>([])
  const [config, setConfig] = useState<PlatformConfig | null>(null)
  const [selected, setSelected] = useState<Set<PlatformId>>(new Set())
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [results, setResults] = useState<PostResult[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setLoadError(null)
      try {
        const nextConfig = await loadConfig(repo)
        const blocks = await readChildBlocks(repo, blockId)
        await applyBuiltInCharacterCounters(
          repo,
          blocks,
          characterLimitForTarget(target, nextConfig),
        )
        const processed = await processBlocks(blocks, repo)
        if (cancelled) return
        setConfig(nextConfig)
        setRawBlocks(blocks)
        setProcessedBlocks(processed)
        setSelected(new Set(platformsForTarget(target, nextConfig)))
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [repo, blockId, target])

  const availablePlatforms = useMemo(() => configuredPlatforms(config ?? {
    bufferToken: null,
    blueskyHandle: '',
    blueskyAppPassword: null,
    lesswrongToken: null,
    corsProxyUrl: '',
  }), [config])

  const validations = useMemo(() => {
    const errors: string[] = []
    if (rawBlocks.length === 0) errors.push('No child blocks found under the focused block')
    for (const platform of selected) {
      if (config && !configuredPlatforms(config).includes(platform)) {
        errors.push(`${PLATFORM_LABELS[platform]} is not configured`)
      }
      errors.push(...validateThread(processedBlocks, platform))
    }
    if (selected.size === 0) errors.push('No platform selected')
    return errors
  }, [config, processedBlocks, rawBlocks.length, selected])

  const togglePlatform = (platform: PlatformId): void => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(platform)) next.delete(platform)
      else next.add(platform)
      return next
    })
  }

  const submit = async (): Promise<void> => {
    if (!config) return
    setSending(true)
    setResults([])
    const platforms = Array.from(selected)
    try {
      const nextResults = await Promise.all(platforms.map(platform =>
        postToPlatform(platform, processedBlocks, rawBlocks, repo, config)))
      setResults(nextResults)
      await annotateParent(repo, blockId, nextResults)
      const failures = nextResults.filter(result => !result.success)
      if (failures.length === 0) showSuccess('Published social posts')
      else showError(`Publishing finished with ${failures.length} failure${failures.length === 1 ? '' : 's'}`)
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) cancel() }}>
      <DialogContent className='max-w-2xl'>
        <DialogHeader>
          <DialogTitle>Publish to social media</DialogTitle>
          <DialogDescription>
            Publishes each child block as a thread item; LessWrong receives one combined shortform post.
          </DialogDescription>
        </DialogHeader>

        {loading && <div className='text-sm text-muted-foreground'>Loading draft...</div>}
        {loadError && (
          <div className='flex items-center gap-2 rounded-md border border-destructive/40 p-3 text-sm text-destructive'>
            <AlertCircleIcon className='h-4 w-4' />
            {loadError}
          </div>
        )}
        {!loading && !loadError && (
          <div className='grid gap-4'>
            <div className='grid gap-2'>
              <div className='text-sm font-medium'>Platforms</div>
              <div className='flex flex-wrap gap-2'>
                {(['twitter', 'bluesky', 'lesswrong'] as PlatformId[]).map(platform => {
                  const configured = availablePlatforms.includes(platform)
                  const active = selected.has(platform)
                  return (
                    <Button
                      key={platform}
                      type='button'
                      size='sm'
                      variant={active ? 'default' : 'outline'}
                      onClick={() => togglePlatform(platform)}
                      disabled={target !== 'all' && target !== platform}
                      title={configured ? PLATFORM_LABELS[platform] : `${PLATFORM_LABELS[platform]} is not configured`}
                    >
                      {configured ? <CheckCircleIcon className='mr-2 h-4 w-4' /> : <AlertCircleIcon className='mr-2 h-4 w-4' />}
                      {PLATFORM_SHORT_LABELS[platform]}
                    </Button>
                  )
                })}
              </div>
            </div>

            <div className='max-h-56 overflow-auto rounded-md border'>
              {processedBlocks.length === 0 ? (
                <div className='p-3 text-sm text-muted-foreground'>No child posts to preview.</div>
              ) : processedBlocks.map((block, index) => (
                <div key={block.id} className='border-b p-3 last:border-b-0'>
                  <div className='mb-1 text-xs text-muted-foreground'>Post {index + 1}</div>
                  <div className='whitespace-pre-wrap text-sm'>{block.text || '(media only)'}</div>
                  {block.mediaUrls.length > 0 && (
                    <div className='mt-1 text-xs text-muted-foreground'>
                      {block.mediaUrls.length} image{block.mediaUrls.length === 1 ? '' : 's'}
                    </div>
                  )}
                  <div className='mt-2 flex gap-3 text-xs text-muted-foreground'>
                    <span>X {countForPlatform(block, 'twitter')}/{TWITTER_CHAR_LIMIT}</span>
                    <span>Bluesky {countForPlatform(block, 'bluesky')}/{BLUESKY_CHAR_LIMIT}</span>
                  </div>
                </div>
              ))}
            </div>

            {validations.length > 0 && (
              <div className='rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive'>
                {validations.map(error => <div key={error}>{error}</div>)}
              </div>
            )}

            {results.length > 0 && (
              <div className='grid gap-2 rounded-md border p-3 text-sm'>
                {results.map(result => (
                  <div key={result.platform} className='flex items-center gap-2'>
                    {result.success ? (
                      <CheckCircleIcon className='h-4 w-4 text-green-600' />
                    ) : (
                      <AlertCircleIcon className='h-4 w-4 text-destructive' />
                    )}
                    <span>{PLATFORM_LABELS[result.platform]}</span>
                    {result.url && (
                      <a
                        className='inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline'
                        href={result.url}
                        target='_blank'
                        rel='noreferrer'
                      >
                        View
                        <ExternalLinkIcon className='h-3 w-3' />
                      </a>
                    )}
                    {result.error && <span className='text-destructive'>{result.error}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button type='button' variant='outline' onClick={() => resolve(false)} disabled={sending}>
            Close
          </Button>
          <Button type='button' onClick={submit} disabled={loading || sending || validations.length > 0}>
            <SendIcon className='mr-2 h-4 w-4' />
            {sending ? 'Publishing...' : 'Publish'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface CredentialsDialogProps {
  repo: any
}

const CredentialsDialog = ({
  repo,
  resolve,
  cancel,
}: DialogContextProps<boolean> & CredentialsDialogProps) => {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [bufferToken, setBufferToken] = useState('')
  const [blueskyHandle, setBlueskyHandle] = useState('')
  const [blueskyPassword, setBlueskyPassword] = useState('')
  const [lesswrongToken, setLesswrongToken] = useState('')
  const [corsProxyUrl, setCorsProxyUrl] = useState('')
  const [status, setStatus] = useState({twitter: false, bluesky: false, lesswrong: false})

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const nextConfig = await loadConfig(repo)
      if (cancelled) return
      setBlueskyHandle(nextConfig.blueskyHandle)
      setCorsProxyUrl(nextConfig.corsProxyUrl)
      setStatus({
        twitter: Boolean(nextConfig.bufferToken),
        bluesky: Boolean(nextConfig.blueskyHandle && nextConfig.blueskyAppPassword),
        lesswrong: Boolean(nextConfig.lesswrongToken),
      })
      setLoading(false)
    }
    void load()
    return () => { cancelled = true }
  }, [repo])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const prefs = await prefsBlock(repo)
      if (prefs) {
        await prefs.set(blueskyHandleProp, blueskyHandle.trim())
        await prefs.set(corsProxyUrlProp, corsProxyUrl.trim())
      }
      if (bufferToken.trim()) saveBufferToken(bufferToken.trim())
      if (blueskyPassword.trim()) saveBlueskyAppPassword(blueskyPassword.trim())
      if (lesswrongToken.trim()) saveLessWrongToken(lesswrongToken.trim())
      await updateCredentialHints(repo)
      showSuccess('Saved social publisher credentials')
      resolve(true)
    } finally {
      setSaving(false)
    }
  }

  const clearDeviceCredentials = async (): Promise<void> => {
    clearBufferToken()
    clearBlueskyAppPassword()
    clearLessWrongToken()
    await updateCredentialHints(repo)
    setBufferToken('')
    setBlueskyPassword('')
    setLesswrongToken('')
    setStatus({twitter: false, bluesky: false, lesswrong: false})
    showInfo('Cleared device-local social publisher credentials')
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) cancel() }}>
      <DialogContent className='max-w-xl'>
        <DialogHeader>
          <DialogTitle>Social Publisher credentials</DialogTitle>
          <DialogDescription>
            Blank secret fields keep the existing local value. Secrets stay on this device.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className='text-sm text-muted-foreground'>Loading credentials...</div>
        ) : (
          <div className='grid gap-4'>
            <div className='grid gap-2'>
              <Label htmlFor='smp-buffer-token'>Buffer API token</Label>
              <Input
                id='smp-buffer-token'
                type='password'
                value={bufferToken}
                placeholder={status.twitter ? 'Configured; leave blank to keep' : 'Buffer API token'}
                onChange={event => setBufferToken(event.target.value)}
              />
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='smp-bluesky-handle'>Bluesky handle</Label>
              <Input
                id='smp-bluesky-handle'
                value={blueskyHandle}
                placeholder='user.bsky.social'
                onChange={event => setBlueskyHandle(event.target.value)}
              />
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='smp-bluesky-password'>Bluesky app password</Label>
              <Input
                id='smp-bluesky-password'
                type='password'
                value={blueskyPassword}
                placeholder={status.bluesky ? 'Configured; leave blank to keep' : 'xxxx-xxxx-xxxx-xxxx'}
                onChange={event => setBlueskyPassword(event.target.value)}
              />
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='smp-lesswrong-token'>LessWrong login token</Label>
              <Input
                id='smp-lesswrong-token'
                type='password'
                value={lesswrongToken}
                placeholder={status.lesswrong ? 'Configured; leave blank to keep' : 'LessWrong loginToken'}
                onChange={event => setLesswrongToken(event.target.value)}
              />
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='smp-cors-proxy'>Optional CORS proxy URL</Label>
              <Input
                id='smp-cors-proxy'
                value={corsProxyUrl}
                placeholder='https://your-cors-proxy.example'
                onChange={event => setCorsProxyUrl(event.target.value)}
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button type='button' variant='outline' onClick={clearDeviceCredentials} disabled={saving}>
            Clear local credentials
          </Button>
          <Button type='button' variant='outline' onClick={() => resolve(false)} disabled={saving}>
            Cancel
          </Button>
          <Button type='button' onClick={save} disabled={loading || saving}>
            <SettingsIcon className='mr-2 h-4 w-4' />
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const ConnectedHintEditor = ({value}: PropertyEditorProps<boolean>) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 12,
      color: value ? 'var(--foreground)' : 'var(--muted-foreground)',
    }}
  >
    {value ? <CheckCircleIcon style={{width: 14, height: 14}} /> : <AlertCircleIcon style={{width: 14, height: 14}} />}
    {value ? 'configured on this device' : 'not configured on this device'}
  </span>
)

const blueskyHandleEditor = definePropertyEditorOverride<string>({
  name: blueskyHandleProp.name,
  label: 'Bluesky handle',
})
const corsProxyUrlEditor = definePropertyEditorOverride<string>({
  name: corsProxyUrlProp.name,
  label: 'CORS proxy URL',
})
const twitterConnectedEditor = definePropertyEditorOverride<boolean>({
  name: twitterConnectedHintProp.name,
  label: 'X / Twitter',
  Editor: ConnectedHintEditor,
})
const blueskyConnectedEditor = definePropertyEditorOverride<boolean>({
  name: blueskyConnectedHintProp.name,
  label: 'Bluesky',
  Editor: ConnectedHintEditor,
})
const lesswrongConnectedEditor = definePropertyEditorOverride<boolean>({
  name: lesswrongConnectedHintProp.name,
  label: 'LessWrong',
  Editor: ConnectedHintEditor,
})

const commandTargetForTypes = (types: readonly string[]): TargetPlatform | null =>
  commandTypes.find(command => types.includes(command.type.id))?.target ?? null

const commandStyles = {
  wrapper: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
  },
  content: {
    minWidth: 0,
    flex: '1 1 auto',
  },
} satisfies Record<string, CSSProperties>

const CommandBlockButton = ({
  block,
  target,
}: {
  block: any
  target: TargetPlatform
}) => (
  <Button
    type='button'
    size='sm'
    variant='outline'
    title={`Publish to ${target === 'all' ? 'configured platforms' : PLATFORM_LABELS[target]}`}
    onMouseDown={event => event.stopPropagation()}
    onClick={event => {
      event.preventDefault()
      event.stopPropagation()
      void publishFromBlock(block.repo, block.id, target)
    }}
  >
    <SendIcon className='mr-2 h-4 w-4' />
    Publish
  </Button>
)

const commandDecoratorCache = new Map<TargetPlatform, WeakMap<BlockRenderer, BlockRenderer>>()

const decorateCommandBlock = (target: TargetPlatform): BlockContentDecorator => inner => {
  let cache = commandDecoratorCache.get(target)
  if (!cache) {
    cache = new WeakMap<BlockRenderer, BlockRenderer>()
    commandDecoratorCache.set(target, cache)
  }
  const existing = cache.get(inner)
  if (existing) return existing
  const Decorated: BlockRenderer = props => {
    const Inner = inner
    return (
      <div style={commandStyles.wrapper}>
        <div style={commandStyles.content}>
          <Inner {...props} />
        </div>
        <CommandBlockButton block={props.block} target={target} />
      </div>
    )
  }
  Decorated.displayName = 'WithSocialPublishCommand'
  cache.set(inner, Decorated)
  return Decorated
}

const commandBlockDecorator: BlockContentDecoratorContribution = ctx => {
  const target = commandTargetForTypes(ctx.types)
  return target ? decorateCommandBlock(target) : null
}

const openSettingsAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: 'social-publisher.configure',
  description: 'Social Publisher: open settings',
  context: ActionContextTypes.GLOBAL,
  handler: async ({uiStateBlock}: {uiStateBlock: any}) => {
    const repo = uiStateBlock.repo
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) return
    const prefs = await getPluginPrefsBlock(repo, workspaceId, repo.user, publisherPrefsType)
    await updateCredentialHints(repo)
    await prefs.set(showPropertiesProp, true)
    navigate(repo, {target: 'new-panel', blockId: prefs.id, workspaceId})
  },
}

const credentialsAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: 'social-publisher.credentials',
  description: 'Social Publisher: configure credentials',
  context: ActionContextTypes.GLOBAL,
  handler: async ({uiStateBlock}: {uiStateBlock: any}) => {
    await openDialog(CredentialsDialog, {repo: uiStateBlock.repo})
  },
}

const publishAction: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
  id: 'social-publisher.publish',
  description: 'Social Publisher: publish focused block children to configured platforms',
  context: ActionContextTypes.NORMAL_MODE,
  handler: async ({block}: {block: any}) => {
    await publishFromBlock(block.repo, block.id, 'all')
  },
}

const publishTwitterAction: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
  id: 'social-publisher.publish-twitter',
  description: 'Social Publisher: publish focused block children to X / Twitter',
  context: ActionContextTypes.NORMAL_MODE,
  handler: async ({block}: {block: any}) => {
    await publishFromBlock(block.repo, block.id, 'twitter')
  },
}

const publishBlueskyAction: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
  id: 'social-publisher.publish-bluesky',
  description: 'Social Publisher: publish focused block children to Bluesky',
  context: ActionContextTypes.NORMAL_MODE,
  handler: async ({block}: {block: any}) => {
    await publishFromBlock(block.repo, block.id, 'bluesky')
  },
}

const publishLessWrongAction: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
  id: 'social-publisher.publish-lesswrong',
  description: 'Social Publisher: publish focused block children to LessWrong',
  context: ActionContextTypes.NORMAL_MODE,
  handler: async ({block}: {block: any}) => {
    await publishFromBlock(block.repo, block.id, 'lesswrong')
  },
}

export default [
  dialogAppMountExtension,

  typesFacet.of(publisherPrefsType, {source}),
  ...commandTypes.map(command => typesFacet.of(command.type, {source})),

  propertySchemasFacet.of(blueskyHandleProp, {source}),
  propertySchemasFacet.of(corsProxyUrlProp, {source}),
  propertySchemasFacet.of(twitterConnectedHintProp, {source}),
  propertySchemasFacet.of(blueskyConnectedHintProp, {source}),
  propertySchemasFacet.of(lesswrongConnectedHintProp, {source}),

  propertyEditorOverridesFacet.of(blueskyHandleEditor, {source}),
  propertyEditorOverridesFacet.of(corsProxyUrlEditor, {source}),
  propertyEditorOverridesFacet.of(twitterConnectedEditor, {source}),
  propertyEditorOverridesFacet.of(blueskyConnectedEditor, {source}),
  propertyEditorOverridesFacet.of(lesswrongConnectedEditor, {source}),

  blockContentDecoratorsFacet.of(commandBlockDecorator, {source}),

  actionsFacet.of(openSettingsAction, {source}),
  actionsFacet.of(credentialsAction, {source}),
  actionsFacet.of(publishAction, {source}),
  actionsFacet.of(publishTwitterAction, {source}),
  actionsFacet.of(publishBlueskyAction, {source}),
  actionsFacet.of(publishLessWrongAction, {source}),
]
