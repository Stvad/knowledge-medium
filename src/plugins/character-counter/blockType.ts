/** Character-counter block type. `CHAR_COUNTER_TYPE` is a generic,
 *  user-applicable tag — add it to any block (a tweet draft, an abstract,
 *  a summary field) to get a live character count below its content. The
 *  `char:*` fields are lifted onto the type so `addType` seeds defaults and
 *  the property panel surfaces them in the type section, mirroring the geo
 *  plugin's lift of `place:*` fields. */

import { seedType, type TypeSeedDeclaration } from '@/data/api'
import { charLimitProp, charProfileProp, charScopeProp } from './properties'

export const CHAR_COUNTER_TYPE = 'char-counter'

export const CHAR_COUNTER_TYPE_CONTRIBUTIONS: readonly TypeSeedDeclaration[] = [
  seedType({
    seedKey: 'system:character-counter/type/char-counter',
    revision: 1,
    id: CHAR_COUNTER_TYPE,
    label: 'Character counter',
    description: 'Shows a live character count below the block. Set an optional limit to see `count / limit` and an over-limit warning.',
    properties: [charLimitProp, charScopeProp, charProfileProp],
  }),
]
