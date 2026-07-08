import {getPluginPrefsBlock} from '@/data/stateBlocks.js'

import {
  BLUESKY_APP_PASSWORD_KEY,
  BUFFER_TOKEN_KEY,
  LESSWRONG_TOKEN_KEY,
} from './constants'
import {
  blueskyConnectedHintProp,
  blueskyHandleProp,
  corsProxyUrlProp,
  lesswrongConnectedHintProp,
  publisherPrefsType,
  twitterConnectedHintProp,
} from './properties'
import type {PlatformConfig, PlatformId, TargetPlatform} from './types'

export const loadBufferToken = (): string | null => window.localStorage.getItem(BUFFER_TOKEN_KEY)
export const saveBufferToken = (value: string): void =>
  window.localStorage.setItem(BUFFER_TOKEN_KEY, value)
export const clearBufferToken = (): void => window.localStorage.removeItem(BUFFER_TOKEN_KEY)

export const loadBlueskyAppPassword = (): string | null =>
  window.localStorage.getItem(BLUESKY_APP_PASSWORD_KEY)
export const saveBlueskyAppPassword = (value: string): void =>
  window.localStorage.setItem(BLUESKY_APP_PASSWORD_KEY, value)
export const clearBlueskyAppPassword = (): void =>
  window.localStorage.removeItem(BLUESKY_APP_PASSWORD_KEY)

export const loadLessWrongToken = (): string | null =>
  window.localStorage.getItem(LESSWRONG_TOKEN_KEY)
export const saveLessWrongToken = (value: string): void =>
  window.localStorage.setItem(LESSWRONG_TOKEN_KEY, value)
export const clearLessWrongToken = (): void => window.localStorage.removeItem(LESSWRONG_TOKEN_KEY)

export const prefsBlock = async (repo: any) => {
  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId) return null
  return getPluginPrefsBlock(repo, workspaceId, repo.user, publisherPrefsType)
}

export const loadConfig = async (repo: any): Promise<PlatformConfig> => {
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

export const updateCredentialHints = async (repo: any): Promise<void> => {
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

export const configuredPlatforms = (config: PlatformConfig): PlatformId[] => {
  const platforms: PlatformId[] = []
  if (config.bufferToken) platforms.push('twitter')
  if (config.blueskyHandle && config.blueskyAppPassword) platforms.push('bluesky')
  if (config.lesswrongToken) platforms.push('lesswrong')
  return platforms
}

export const platformsForTarget = (
  target: TargetPlatform,
  config: PlatformConfig,
): PlatformId[] => target === 'all' ? configuredPlatforms(config) : [target]
