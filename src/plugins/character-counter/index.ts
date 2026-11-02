/** Character-counter plugin — tag a block "Character counter" (or "Word
 *  counter", the same counter preset to words over its subtree) to show a
 *  live character or word count below its content, below each direct child,
 *  or as one total for its subtree, with an optional per-block limit and
 *  pluggable counting profiles.
 *  The count is purely additive (a decorator over the existing renderer)
 *  and the limit is visual-only; neither ever blocks editing. */

import { blockContentDecoratorsFacet } from '@/extensions/blockInteraction.js'
import { propertyEditorOverridesFacet } from '@/data/facets'
import type { AppExtension } from '@/facets/facet'
import { systemToggle } from '@/facets/togglable'
import { characterCounterDataExtension } from './dataExtension'
import { characterCountDecoratorContribution } from './CharacterCountDecorator'
import { builtinCountProfiles } from './profiles'
import { charProfileEditorOverride } from './ProfilePropertyEditor'

export { CHAR_COUNTER_TYPE, WORD_COUNTER_TYPE } from './blockType'
export {
  charLimitProp,
  charProfileProp,
  charScopeProp,
  RAW_CHARACTER_COUNT_PROFILE_ID,
  WORDS_COUNT_PROFILE_ID,
  type CharacterCounterScope,
} from './properties'
export { charCountDisplay } from './charCount'
export {
  characterCountProfilesFacet,
  textCountProfile,
  type CharacterCountProfile,
} from './profiles'

export const characterCounterPlugin: AppExtension = systemToggle({
  id: 'system:character-counter',
  name: 'Character counter',
  description: 'Tag a block "Character counter" or "Word counter" to show a live character or word count below it, its direct children, or its whole subtree, with an optional limit.',
}).of([
  characterCounterDataExtension,
  builtinCountProfiles,
  propertyEditorOverridesFacet.of(charProfileEditorOverride, {source: 'character-counter'}),
  blockContentDecoratorsFacet.of(characterCountDecoratorContribution, {source: 'character-counter'}),
])
