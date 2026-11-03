/** Counter block types. `CHAR_COUNTER_TYPE` is a generic, user-applicable
 *  tag — add it to any block (a tweet draft, an abstract, a summary field, an
 *  essay's root) to get a live character or word count. `WORD_COUNTER_TYPE` is
 *  the same counter, tagged with words over the whole subtree already set
 *  (`wordCounterInitialValues`). Both lift the `char:*` fields so the property
 *  panel surfaces them in the type section, mirroring the geo plugin's lift of
 *  `place:*` fields. */

import { propertyValue, seedType, type TypeSeedDeclaration } from '@/data/api'
import { typeInitialValuesProcessor } from '@/data/typeInitialValues'
import {
  charLimitProp,
  charProfileProp,
  charScopeProp,
  WORDS_COUNT_PROFILE_ID,
} from './properties'

export const CHAR_COUNTER_TYPE = 'char-counter'
export const WORD_COUNTER_TYPE = 'word-counter'
export const COUNTER_TYPES: readonly string[] = [CHAR_COUNTER_TYPE, WORD_COUNTER_TYPE]

const counterProperties = [charLimitProp, charScopeProp, charProfileProp]

export const CHAR_COUNTER_TYPE_CONTRIBUTIONS: readonly TypeSeedDeclaration[] = [
  seedType({
    seedKey: 'system:character-counter/type/char-counter',
    revision: 1,
    id: CHAR_COUNTER_TYPE,
    label: 'Character counter',
    description: 'Shows a live count below the block: characters or words (`char:profile`), for the block, each direct child, or the whole subtree (`char:scope`). Set an optional limit to see `count / limit` and an over-limit warning.',
    properties: counterProperties,
  }),
  seedType({
    seedKey: 'system:character-counter/type/word-counter',
    revision: 1,
    id: WORD_COUNTER_TYPE,
    label: 'Word counter',
    description: 'Shows a live word count below the block for the block and everything nested under it. Change `char:scope` or `char:profile` to count something else; set an optional limit to see `count / limit`.',
    properties: counterProperties,
  }),
]

export const wordCounterInitialValues = typeInitialValuesProcessor(WORD_COUNTER_TYPE, [
  propertyValue(charScopeProp, 'subtree'),
  propertyValue(charProfileProp, WORDS_COUNT_PROFILE_ID),
])
