/** Character-counter plugin property schemas.
 *
 *  `char:limit` is the optional per-counter limit. Undefined ≡ "no limit" →
 *  the counter shows a bare count. When set to a positive number the counter
 *  renders `count / limit` and flags the over-limit state.
 *
 *  `char:scope` controls where the counter appears: `self` counts the tagged
 *  block itself, `children` makes the tagged block configure counters for its
 *  direct children, and `subtree` shows one total for the tagged block and
 *  everything nested under it.
 *
 *  `char:profile` is the id of a `characterCountProfilesFacet` entry — the
 *  counting method (`raw` characters, `words`, or a plugin's platform count).
 *  Stored as a string, not an enum, because plugins register profiles at
 *  runtime; its editor override offers the registered ones as a select. */

import { ChangeScope, seedProperty } from '@/data/api'

export type CharacterCounterScope = 'self' | 'children' | 'subtree'

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
    {value: 'subtree', label: 'subtree'},
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
