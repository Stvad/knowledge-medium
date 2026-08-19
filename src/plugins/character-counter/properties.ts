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

import { ChangeScope, seedProperty } from '@/data/api'

export type CharacterCounterScope = 'self' | 'children'

export const charLimitProp = seedProperty({
  seedKey: 'system:character-counter/property/limit',
  revision: 1,
  name: 'char:limit',
  preset: 'optional-number',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const charScopeProp = seedProperty<CharacterCounterScope>({
  seedKey: 'system:character-counter/property/scope',
  revision: 1,
  name: 'char:scope',
  preset: 'strict-enum',
  config: {options: [
    {value: 'self', label: 'self'},
    {value: 'children', label: 'children'},
  ]},
  defaultValue: 'self',
  changeScope: ChangeScope.BlockDefault,
})

export const charProfileProp = seedProperty({
  seedKey: 'system:character-counter/property/profile',
  revision: 1,
  name: 'char:profile',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
