import {
  ChangeScope,
  defineBlockType,
  seedProperty,
  extensionPropertySeedKey,
} from '@/extensions/api.js'

import type {TargetPlatform} from './types'

export const blueskyHandleProp = seedProperty({
  seedKey: extensionPropertySeedKey('bluesky-handle'),
  revision: 1,
  name: 'socialPublisher:blueskyHandle',
  preset: 'string',
  defaultValue: '',
  changeScope: ChangeScope.UserPrefs,
})

export const corsProxyUrlProp = seedProperty({
  seedKey: extensionPropertySeedKey('cors-proxy-url'),
  revision: 1,
  name: 'socialPublisher:corsProxyUrl',
  preset: 'string',
  defaultValue: '',
  changeScope: ChangeScope.UserPrefs,
})

// Schema-only settings rows. Their editors derive device-local credential
// status directly and never persist these values to synced user preferences.
export const twitterConnectedHintProp = seedProperty({
  seedKey: extensionPropertySeedKey('twitter-configured'),
  revision: 1,
  name: 'socialPublisher:twitterConfigured',
  preset: 'boolean',
  defaultValue: false,
  changeScope: ChangeScope.UserPrefs,
})

export const blueskyConnectedHintProp = seedProperty({
  seedKey: extensionPropertySeedKey('bluesky-configured'),
  revision: 1,
  name: 'socialPublisher:blueskyConfigured',
  preset: 'boolean',
  defaultValue: false,
  changeScope: ChangeScope.UserPrefs,
})

export const lesswrongConnectedHintProp = seedProperty({
  seedKey: extensionPropertySeedKey('lesswrong-configured'),
  revision: 1,
  name: 'socialPublisher:lesswrongConfigured',
  preset: 'boolean',
  defaultValue: false,
  changeScope: ChangeScope.UserPrefs,
})

export const publisherPrefsType = defineBlockType({
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
  label: 'Publish',
  description: 'Command block: publish child blocks to configured social platforms.',
})

const publishTwitterType = defineBlockType({
  id: 'social-publisher-twitter',
  label: 'Tweet',
  description: 'Command block: publish child blocks to X / Twitter via Buffer.',
})

const publishBlueskyType = defineBlockType({
  id: 'social-publisher-bluesky',
  label: 'Bsky',
  description: 'Command block: publish child blocks to Bluesky.',
})

const publishLessWrongType = defineBlockType({
  id: 'social-publisher-lesswrong',
  label: 'LW',
  description: 'Command block: publish child blocks to LessWrong shortform.',
})

export const commandTypes = [
  {type: publishAllType, target: 'all' as const},
  {type: publishTwitterType, target: 'twitter' as const},
  {type: publishBlueskyType, target: 'bluesky' as const},
  {type: publishLessWrongType, target: 'lesswrong' as const},
] as const

export const commandTargetForTypes = (types: readonly string[]): TargetPlatform | null =>
  commandTypes.find(command => types.includes(command.type.id))?.target ?? null
