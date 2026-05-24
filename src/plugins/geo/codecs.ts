/** Plugin-local optional ref codec. Core's `codecs.ref` is non-optional
 *  (`Codec<string>`); this is the absence-aware sibling, modeled on
 *  `codecs.optionalString`. Kept inside the geo plugin until a second
 *  consumer emerges — at which point promoting it to `codecs.optionalRef`
 *  in [src/data/api/codecs.ts](../../data/api/codecs.ts) is a trivial
 *  follow-up.
 *
 *  Carries the same `targetTypes` array as a regular `RefCodec` so the
 *  property-panel ref-picker can constrain its candidate list. */

import { CodecError, type Codec, type RefCodecOptions } from '@/data/api/codecs'

export interface OptionalRefCodec extends Codec<string | undefined> {
  readonly type: 'ref'
  readonly targetTypes: readonly string[]
}

export const optionalRefCodec = (options?: RefCodecOptions): OptionalRefCodec => ({
  type: 'ref',
  targetTypes: Object.freeze([...(options?.targetTypes ?? [])]),
  encode: v => (v === undefined ? null : v),
  decode: j => {
    if (j === null || j === undefined) return undefined
    if (typeof j !== 'string') throw new CodecError('ref (string id)', j)
    return j
  },
})
