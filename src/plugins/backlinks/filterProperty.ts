import {
  ChangeScope,
  defineProperty,
  type BlockPredicate,
  type Codec,
} from '@/data/api'
import {
  normalizeBacklinksFilter,
  type BacklinksFilter,
} from './query.ts'

export type StoredBacklinksFilter = Required<BacklinksFilter>

export const EMPTY_BACKLINKS_FILTER: StoredBacklinksFilter = {
  include: [],
  exclude: [],
}

const isObjectRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const parsePredicate = (value: unknown): BlockPredicate | null => {
  if (!isObjectRecord(value)) return null
  const out: BlockPredicate = {}
  if (value.scope === 'self' || value.scope === 'ancestor') {
    out.scope = value.scope
  }
  if (typeof value.id === 'string') {
    out.id = value.id
  }
  if (isObjectRecord(value.where) && Object.keys(value.where).length > 0) {
    out.where = value.where
  }
  if (isObjectRecord(value.referencedBy) && typeof value.referencedBy.id === 'string') {
    const ref: {id: string; sourceField?: string} = {id: value.referencedBy.id}
    if (typeof value.referencedBy.sourceField === 'string') {
      ref.sourceField = value.referencedBy.sourceField
    }
    out.referencedBy = ref
  }
  return out.where || out.referencedBy || out.id ? out : null
}

const parsePredicateList = (value: unknown): BlockPredicate[] => {
  if (!Array.isArray(value)) return []
  const out: BlockPredicate[] = []
  for (const entry of value) {
    const parsed = parsePredicate(entry)
    if (parsed) out.push(parsed)
  }
  return out
}

const parseBacklinksFilter = (value: unknown): BacklinksFilter => {
  if (!isObjectRecord(value)) return {}
  return {
    include: parsePredicateList(value.include),
    exclude: parsePredicateList(value.exclude),
  }
}

/** Filter codec name was bumped from 'backlinks:filter' to
 *  'backlinks:predicates' when the storage shape moved from
 *  `{includeIds, removeIds}` to `{include, exclude}` of BlockPredicate.
 *  Old values stored under the previous name (and its property name)
 *  are intentionally discarded. */
export const backlinksFilterCodec: Codec<StoredBacklinksFilter> = {
  type: 'backlinks:predicates',
  encode: value => normalizeBacklinksFilter(value),
  decode: value => normalizeBacklinksFilter(parseBacklinksFilter(value)),
}

export const backlinksFilterProp = defineProperty<StoredBacklinksFilter>('backlinks:predicates', {
  codec: backlinksFilterCodec,
  defaultValue: EMPTY_BACKLINKS_FILTER,
  changeScope: ChangeScope.BlockDefault,
})

export const readBacklinksFilterProperty = (
  value: unknown,
): StoredBacklinksFilter => backlinksFilterProp.codec.decode(value)
