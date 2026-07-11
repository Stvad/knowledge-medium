import {
  ChangeScope,
  codecs,
  defineBlockType,
  defineProperty,
} from '@/extensions/api.js'

import type {TargetPlatform} from './types'

export const blueskyHandleProp = defineProperty<string>('socialPublisher:blueskyHandle', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.UserPrefs,
})

export const corsProxyUrlProp = defineProperty<string>('socialPublisher:corsProxyUrl', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.UserPrefs,
})

// Schema-only settings rows. Their editors derive device-local credential
// status directly and never persist these values to synced user preferences.
export const twitterConnectedHintProp = defineProperty<boolean>(
  'socialPublisher:twitterConfigured',
  {
    codec: codecs.boolean,
    defaultValue: false,
    changeScope: ChangeScope.UserPrefs,
  },
)

export const blueskyConnectedHintProp = defineProperty<boolean>(
  'socialPublisher:blueskyConfigured',
  {
    codec: codecs.boolean,
    defaultValue: false,
    changeScope: ChangeScope.UserPrefs,
  },
)

export const lesswrongConnectedHintProp = defineProperty<boolean>(
  'socialPublisher:lesswrongConfigured',
  {
    codec: codecs.boolean,
    defaultValue: false,
    changeScope: ChangeScope.UserPrefs,
  },
)

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
