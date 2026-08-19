import {getPluginPrefsBlock} from '@/data/stateBlocks.js'

import {
  BLUESKY_APP_PASSWORD_KEY,
  BUFFER_TOKEN_KEY,
  LESSWRONG_TOKEN_KEY,
} from './constants'
import {
  blueskyHandleProp,
  corsProxyUrlProp,
  publisherPrefsType,
} from './properties'
import type {PlatformConfig, PlatformId, TargetPlatform} from './types'

const credentialKeys = new Set([
  BLUESKY_APP_PASSWORD_KEY,
  BUFFER_TOKEN_KEY,
  LESSWRONG_TOKEN_KEY,
])
const credentialListeners = new Set<() => void>()
let credentialSnapshot = 0

const notifyCredentialListeners = (): void => {
  credentialSnapshot += 1
  credentialListeners.forEach(listener => listener())
}

const handleCredentialStorage = (event: StorageEvent): void => {
  if (event.storageArea !== window.localStorage) return
  if (event.key === null || credentialKeys.has(event.key)) notifyCredentialListeners()
}

export const subscribeCredentialState = (listener: () => void): (() => void) => {
  credentialListeners.add(listener)
  if (credentialListeners.size === 1) {
    window.addEventListener('storage', handleCredentialStorage)
  }
  return () => {
    credentialListeners.delete(listener)
    if (credentialListeners.size === 0) {
      window.removeEventListener('storage', handleCredentialStorage)
    }
  }
}

export const getCredentialSnapshot = (): number => credentialSnapshot

const saveCredential = (key: string, value: string): void => {
  if (window.localStorage.getItem(key) === value) return
  window.localStorage.setItem(key, value)
  notifyCredentialListeners()
}

const clearCredential = (key: string): void => {
  if (window.localStorage.getItem(key) === null) return
  window.localStorage.removeItem(key)
  notifyCredentialListeners()
}

export const loadBufferToken = (): string | null => window.localStorage.getItem(BUFFER_TOKEN_KEY)
export const saveBufferToken = (value: string): void => saveCredential(BUFFER_TOKEN_KEY, value)
export const clearBufferToken = (): void => clearCredential(BUFFER_TOKEN_KEY)

export const loadBlueskyAppPassword = (): string | null =>
  window.localStorage.getItem(BLUESKY_APP_PASSWORD_KEY)
export const saveBlueskyAppPassword = (value: string): void =>
  saveCredential(BLUESKY_APP_PASSWORD_KEY, value)
export const clearBlueskyAppPassword = (): void => clearCredential(BLUESKY_APP_PASSWORD_KEY)

export const loadLessWrongToken = (): string | null =>
  window.localStorage.getItem(LESSWRONG_TOKEN_KEY)
export const saveLessWrongToken = (value: string): void =>
  saveCredential(LESSWRONG_TOKEN_KEY, value)
export const clearLessWrongToken = (): void => clearCredential(LESSWRONG_TOKEN_KEY)

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
