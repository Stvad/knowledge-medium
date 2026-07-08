import {
  AtpAgent,
  RichText,
  type AppBskyEmbedImages,
  type AppBskyFeedPost,
  type Un$Typed,
} from '@atproto/api'

import {
  BSKY_SERVICE_URL,
  BUFFER_API_URL,
  LW_GRAPHQL_URL,
} from './constants'
import {blocksToHtml} from './markdownHtml'
import type {
  PlatformConfig,
  PlatformId,
  PostBlock,
  PostResult,
  ProcessedBlock,
} from './types'
import {withOptionalProxy} from './url'

let cachedBufferChannelId: {token: string; channelId: string} | null = null
type BlueskyImageEmbed = AppBskyEmbedImages.Main & {$type: 'app.bsky.embed.images'}
type BufferImageAssets = {
  images: Array<{
    url: string
    metadata: {altText: string}
  }>
}

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

export const postToTwitter = async (
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
    const buildAssets = (mediaUrls: string[]): BufferImageAssets | undefined => {
      if (mediaUrls.length === 0) return undefined
      return {
        images: mediaUrls.slice(0, 4).map(url => ({
          url,
          metadata: {altText: 'Image from Knowledge Medium'},
        })),
      }
    }

    const firstAssets = buildAssets(postable[0].mediaUrls)

    const input: Record<string, unknown> = {
      text: postable[0].text,
      channelId,
      schedulingType: 'automatic',
      mode: 'shareNow',
    }
    if (firstAssets) input.assets = firstAssets

    if (postable.length > 1) {
      input.metadata = {
        twitter: {
          thread: postable.map(block => {
            const item: Record<string, unknown> = {text: block.text}
            const assets = buildAssets(block.mediaUrls)
            if (assets) item.assets = assets
            return item
          }),
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
  agent: AtpAgent,
  corsProxyUrl: string,
): Promise<BlueskyImageEmbed | null> => {
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

export const postToBluesky = async (
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

    const preparedPosts = await Promise.all(postable.map(async block => {
      const richText = new RichText({text: block.text})
      await richText.detectFacets(agent)
      const embed = await uploadBlueskyImages(block.mediaUrls, agent, config.corsProxyUrl)
      return {richText, embed}
    }))

    let rootRef: {uri: string; cid: string} | undefined
    let parentRef: {uri: string; cid: string} | undefined
    let firstPostUrl: string | undefined

    for (const prepared of preparedPosts) {
      const record: Un$Typed<AppBskyFeedPost.Record> = {
        text: prepared.richText.text,
        facets: prepared.richText.facets,
        createdAt: new Date().toISOString(),
      }
      if (rootRef && parentRef) record.reply = {root: rootRef, parent: parentRef}
      if (prepared.embed) record.embed = prepared.embed

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

export const postToLessWrong = async (
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

export const postToPlatform = async (
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
