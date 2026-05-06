import {
  ChangeScope,
  defineProperty,
  type Codec,
} from '@/data/api'
import {
  normalizeBacklinksFilter,
  type BacklinksFilter,
} from './query.ts'

export type StoredBacklinksFilter = Required<BacklinksFilter>

const EMPTY_BACKLINKS_FILTER: StoredBacklinksFilter = {
  includeIds: [],
  removeIds: [],
}

const parseBacklinksFilter = (value: unknown): BacklinksFilter => {
  if (!value || typeof value !== 'object') return {}
  const record = value as Record<string, unknown>
  return {
    includeIds: Array.isArray(record.includeIds)
      ? record.includeIds.filter((id): id is string => typeof id === 'string')
      : [],
    removeIds: Array.isArray(record.removeIds)
      ? record.removeIds.filter((id): id is string => typeof id === 'string')
      : [],
  }
}

const backlinksFilterCodec: Codec<StoredBacklinksFilter> = {
  shape: 'object',
  encode: value => normalizeBacklinksFilter(value),
  decode: value => normalizeBacklinksFilter(parseBacklinksFilter(value)),
}

export const backlinksFilterProp = defineProperty<StoredBacklinksFilter>('backlinks:filter', {
  codec: backlinksFilterCodec,
  defaultValue: EMPTY_BACKLINKS_FILTER,
  changeScope: ChangeScope.BlockDefault,
})

export const readBacklinksFilterProperty = (
  value: unknown,
): StoredBacklinksFilter => backlinksFilterProp.codec.decode(value)
