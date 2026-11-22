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

export const resolver: QueryResolver = {
  propertyByName: name => PROPERTIES.find(p => p.name === name),
  propertyById: id => PROPERTIES.find(p => p.fieldId === id),
  typeByLabel: label => TYPES.find(t => t.label.toLowerCase() === label.toLowerCase()),
  typeById: id => TYPES.find(t => t.id === id),
  isField: name => name === 'created' || name === 'updated',
  blockIdByAlias: alias => ALIASES[alias],
}

/** UTC+2 all year, so local-day bounds differ visibly from UTC ones. */
export const localDayStart = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) - 2 * 3_600_000
