import {actionsFacet} from '@/extensions/core.js'
import {blockContentDecoratorsFacet} from '@/extensions/blockInteraction.js'
import {dialogAppMountExtension} from '@/extensions/dialogAppMount.js'
import {
  propertyEditorOverridesFacet,
  propertySchemasFacet,
  typesFacet,
} from '@/data/facets.js'
import {characterCountProfilesFacet} from '@/plugins/character-counter/index.js'

import {socialPublisherActions} from './actions'
import {
  blueskyConnectedEditor,
  blueskyHandleEditor,
  corsProxyUrlEditor,
  lesswrongConnectedEditor,
  twitterConnectedEditor,
} from './CredentialsDialog'
import {
  blueskyCountProfile,
  twitterCountProfile,
} from './characterProfiles'
import {source} from './constants'
import {commandBlockDecorator} from './commandDecorator'
import {
  blueskyConnectedHintProp,
  blueskyHandleProp,
  commandTypes,
  corsProxyUrlProp,
  lesswrongConnectedHintProp,
  publisherPrefsType,
  twitterConnectedHintProp,
} from './properties'

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

  characterCountProfilesFacet.of(twitterCountProfile, {source}),
  characterCountProfilesFacet.of(blueskyCountProfile, {source}),

  blockContentDecoratorsFacet.of(commandBlockDecorator, {source}),

  ...socialPublisherActions.map(action => actionsFacet.of(action, {source})),
]
