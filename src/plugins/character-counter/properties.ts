/** Character-counter plugin property schemas.
 *
 *  `char:limit` is the optional per-counter limit. Undefined ≡ "no limit" →
 *  the counter shows a bare count. When set to a positive number the counter
 *  renders `count / limit` and flags the over-limit state.
 *
 *  `char:scope` controls where the counter appears: `self` counts the tagged
 *  block itself, while `children` makes the tagged block configure counters
 *  for its direct children.
 *
 *  `char:profile` is a registry key for count preprocessing. Keeping the
 *  property as a string avoids persisting behavior while still letting
 *  plugins provide platform-specific counting hooks through
 *  `characterCountProfilesFacet`. */

import { ChangeScope, codecs, defineProperty } from '@/data/api'

export type CharacterCounterScope = 'self' | 'children'

export const charLimitProp = defineProperty<number | undefined>('char:limit', {
  codec: codecs.optionalNumber,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const charScopeProp = defineProperty<CharacterCounterScope>('char:scope', {
  codec: codecs.enum(['self', 'children']),
  defaultValue: 'self',
  changeScope: ChangeScope.BlockDefault,
})

export const charProfileProp = defineProperty<string | undefined>('char:profile', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
