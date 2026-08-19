import {ChangeScope} from '@/data/api/index.js'
import {getBlockTypes} from '@/data/properties.js'
import {
  CHAR_COUNTER_TYPE,
  charLimitProp,
  charProfileProp,
  charScopeProp,
} from '@/plugins/character-counter/index.js'

import {
  BLUESKY_CHAR_LIMIT,
  BLUESKY_COUNT_PROFILE_ID,
  TWITTER_CHAR_LIMIT,
  TWITTER_COUNT_PROFILE_ID,
} from './constants'
import type {TargetPlatform} from './types'

interface SocialCounterConfig {
  limit: number
  profileId: string
}

const SOCIAL_COUNT_PROFILE_IDS = new Set([
  TWITTER_COUNT_PROFILE_ID,
  BLUESKY_COUNT_PROFILE_ID,
])

const socialCounterForTarget = (target: TargetPlatform): SocialCounterConfig | undefined => {
  if (target === 'twitter') {
    return {limit: TWITTER_CHAR_LIMIT, profileId: TWITTER_COUNT_PROFILE_ID}
  }
  if (target === 'bluesky') {
    return {limit: BLUESKY_CHAR_LIMIT, profileId: BLUESKY_COUNT_PROFILE_ID}
  }
  if (target === 'all') {
    return {limit: TWITTER_CHAR_LIMIT, profileId: TWITTER_COUNT_PROFILE_ID}
  }
  return undefined
}

export const ensureSocialCounterForCommand = async (
  repo: any,
  blockId: string,
  target: TargetPlatform,
): Promise<void> => {
  const block = repo.block(blockId)
  const data = await block.load()
  if (!data) return

  const counter = socialCounterForTarget(target)
  const currentTypes = getBlockTypes(data)
  const currentProfile = block.peekProperty(charProfileProp)

  if (!counter) {
    if (
      currentTypes.includes(CHAR_COUNTER_TYPE) &&
      currentProfile &&
      SOCIAL_COUNT_PROFILE_IDS.has(currentProfile)
    ) {
      await repo.tx(async (tx: any) => {
        await repo.removeTypeInTx(tx, blockId, CHAR_COUNTER_TYPE)
      }, {scope: ChangeScope.BlockDefault, description: 'clear social publisher counter'})
    }
    return
  }

  const currentScope = block.peekProperty(charScopeProp)
  const currentLimit = block.peekProperty(charLimitProp)
  if (
    currentTypes.includes(CHAR_COUNTER_TYPE) &&
    currentScope === 'children' &&
    currentLimit === counter.limit &&
    currentProfile === counter.profileId
  ) {
    return
  }

  if (!repo.types?.has?.(CHAR_COUNTER_TYPE)) return

  const typeSnapshot = repo.snapshotTypeRegistries()
  await repo.tx(async (tx: any) => {
    await repo.addTypeInTx(tx, blockId, CHAR_COUNTER_TYPE, {}, typeSnapshot)
    await tx.setProperty(blockId, charScopeProp, 'children')
    await tx.setProperty(blockId, charLimitProp, counter.limit)
    await tx.setProperty(blockId, charProfileProp, counter.profileId)
  }, {scope: ChangeScope.BlockDefault, description: 'social publisher character counter'})
}
