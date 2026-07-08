import {RichText} from '@atproto/api'
import twitterText from 'twitter-text'

import {
  BLUESKY_CHAR_LIMIT,
  TWITTER_CHAR_LIMIT,
} from './constants'
import type {PlatformId, ProcessedBlock} from './types'
import {PLATFORM_LABELS} from './types'

export const twitterWeightedLength = (text: string): number =>
  twitterText.parseTweet(text).weightedLength

export const blueskyGraphemeLength = (text: string): number =>
  new RichText({text}).graphemeLength

export const countForPlatform = (block: ProcessedBlock, platform: PlatformId): number =>
  platform === 'bluesky'
    ? blueskyGraphemeLength(block.text)
    : platform === 'twitter'
      ? twitterWeightedLength(block.text)
      : block.text.length

export const validateThread = (
  blocks: ProcessedBlock[],
  platform: PlatformId,
): string[] => {
  if (platform === 'lesswrong') return []
  const limit = platform === 'twitter' ? TWITTER_CHAR_LIMIT : BLUESKY_CHAR_LIMIT
  return blocks.flatMap((block, index) => {
    const count = countForPlatform(block, platform)
    if (!block.text && block.mediaUrls.length === 0) return [`Post ${index + 1} is empty`]
    if (count > limit) {
      return [
        `Post ${index + 1} is ${count - limit} chars over ${PLATFORM_LABELS[platform]}'s limit`,
      ]
    }
    return []
  })
}
