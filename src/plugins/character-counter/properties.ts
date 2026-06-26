/** Character-counter plugin property schemas.
 *
 *  `char:limit` is the single, optional per-block limit. Undefined ≡ "no
 *  limit" → the counter shows a bare count. When set to a positive number
 *  the counter renders `count / limit` and flags the over-limit state.
 *  Visual only — the limit never blocks typing (see CharacterCountDecorator). */

import { ChangeScope, codecs, defineProperty } from '@/data/api'

export const charLimitProp = defineProperty<number | undefined>('char:limit', {
  codec: codecs.optionalNumber,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
