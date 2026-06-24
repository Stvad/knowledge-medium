/** Character-counter block type. `CHAR_COUNTER_TYPE` is a generic,
 *  user-applicable tag — add it to any block (a tweet draft, an abstract,
 *  a summary field) to get a live character count below its content. The
 *  optional `char:limit` field is lifted onto the type so `addType` seeds
 *  its default and the property panel surfaces it in the type section,
 *  mirroring the geo plugin's lift of `place:*` fields. */

import { defineBlockType, type TypeContribution } from '@/data/api'
import { charLimitProp } from './properties'

export const CHAR_COUNTER_TYPE = 'char-counter'

export const CHAR_COUNTER_TYPE_CONTRIBUTIONS: readonly TypeContribution[] = [
  defineBlockType({
    id: CHAR_COUNTER_TYPE,
    label: 'Character counter',
    description: 'Shows a live character count below the block. Set an optional limit to see `count / limit` and an over-limit warning.',
    properties: [charLimitProp],
  }),
]
