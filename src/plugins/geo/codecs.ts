/** Backward-compatible geo-plugin name for the kernel optional-ref codec. */

import {codecs, type OptionalRefCodec} from '@/data/api/codecs'

export type {OptionalRefCodec}
export const optionalRefCodec: typeof codecs.optionalRef = codecs.optionalRef
