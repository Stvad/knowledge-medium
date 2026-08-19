/** Character-counter plugin — tag a block "Character counter" to show a
 *  live character count below its content or below its direct children,
 *  with an optional per-block limit and pluggable preprocessing profiles.
 *  The count is purely additive (a decorator over the existing renderer)
 *  and the limit is visual-only; neither ever blocks editing. */

import { blockContentDecoratorsFacet } from '@/extensions/blockInteraction.js'
import type { AppExtension } from '@/facets/facet'
import { systemToggle } from '@/facets/togglable'
import { characterCounterDataExtension } from './dataExtension'
import { characterCountDecoratorContribution } from './CharacterCountDecorator'

export { CHAR_COUNTER_TYPE } from './blockType'
export { charLimitProp, charProfileProp, charScopeProp, type CharacterCounterScope } from './properties'
export { charCountDisplay } from './charCount'
export {
  characterCountProfilesFacet,
  RAW_CHARACTER_COUNT_PROFILE_ID,
  type CharacterCountProfile,
} from './profiles'

export const characterCounterPlugin: AppExtension = systemToggle({
  id: 'system:character-counter',
  name: 'Character counter',
  description: 'Tag a block "Character counter" to show a live character count below it or its direct children, with an optional limit.',
}).of([
  characterCounterDataExtension,
  blockContentDecoratorsFacet.of(characterCountDecoratorContribution, {source: 'character-counter'}),
])
