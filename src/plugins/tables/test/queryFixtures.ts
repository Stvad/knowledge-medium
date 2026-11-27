import { ChangeScope, codecs, defineProperty, type AnyPropertySchema } from '@/data/api'
import type { QueryProperty, QueryResolver, QueryType } from '../query/parse'

const property = (name: string, codec: AnyPropertySchema['codec']): QueryProperty => ({
  name, fieldId: `f-${name.replace(/\s/g, '-')}`,
  schema: defineProperty(name, {codec, defaultValue: undefined, changeScope: ChangeScope.BlockDefault}) as AnyPropertySchema,
})

export const PROPERTIES: readonly QueryProperty[] = [
  property('status', codecs.enum(['open', 'closed', 'two words'])),
  property('rating', codecs.number),
  property('label', codecs.string),
  property('done', codecs.boolean),
  property('due', codecs.date),
  property('tags', codecs.list(codecs.string)),
  property('scores', codecs.list(codecs.number)),
  property('assignee', codecs.ref()),
  property('related', codecs.refList()),
  property('due date', codecs.string),
  property('under', codecs.string),
]

export const TYPES: readonly QueryType[] = [
  {id: 't-book', label: 'Book'},
  {id: 't-article', label: 'article'},
  {id: 't-reading', label: 'Reading list'},
]

export const MARY = '0190a0c0-0000-7000-8000-00000000000a'
export const PROJECTS = '0190a0c0-0000-7000-8000-00000000000b'
export const ALIASES: Readonly<Record<string, string>> = {Mary: MARY, Projects: PROJECTS}

/** Plugin fields with their own operand rules, as `QueryableField.encode` declares them. */
const scoreEncode = (operand: unknown) => {
  if (typeof operand !== 'number' || !Number.isFinite(operand)) throw new TypeError('score takes a number')
  return operand
}
const contentEncode = (operand: unknown) => {
  if (typeof operand !== 'string') throw new TypeError('content takes text')
  return operand
}

export const resolver: QueryResolver = {
  propertyByName: name => PROPERTIES.find(p => p.name === name),
  propertyById: id => PROPERTIES.find(p => p.fieldId === id),
  refValueTarget: () => undefined,
  typeByLabel: label => TYPES.find(t => t.label.toLowerCase() === label.toLowerCase()),
  typeById: id => TYPES.find(t => t.id === id),
  field: name => name === 'created' || name === 'updated' ? {kind: 'instant'}
    : name === 'test:score' ? {kind: 'value', encode: scoreEncode}
      : name === 'test:content' ? {kind: 'value', encode: contentEncode}
        : undefined,
  blockIdByAlias: alias => ALIASES[alias],
}

/** UTC+2 all year, so local-day bounds differ visibly from UTC ones. */
export const localDayStart = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) - 2 * 3_600_000
