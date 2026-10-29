import {ChangeScope, seedProperty, seedType, type BlockData} from '@/data/api'
import type {RangeAnchor} from './anchor.ts'

/** A comment thread's root. Its content is the quoted text of the target (empty
 *  for a whole-block thread), and its visible children are the comments. */
export const THREAD_TYPE = 'annotation:thread'

/** The annotated block. The one place the target's id lives; discovery is the
 *  `block_references` row this projects, with `source_field` = this name. */
export const annotationTargetProp = seedProperty({
  seedKey: 'system:annotations/property/target',
  revision: 1,
  name: 'annotation:target',
  preset: 'ref',
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
  hidden: true,
})

export const annotationQuoteStartProp = seedProperty({
  seedKey: 'system:annotations/property/quote-start',
  revision: 1,
  name: 'annotation:quoteStart',
  preset: 'optional-number',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
  hidden: true,
})

export const annotationQuotePrefixProp = seedProperty({
  seedKey: 'system:annotations/property/quote-prefix',
  revision: 1,
  name: 'annotation:quotePrefix',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
  hidden: true,
})

export const annotationQuoteSuffixProp = seedProperty({
  seedKey: 'system:annotations/property/quote-suffix',
  revision: 1,
  name: 'annotation:quoteSuffix',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
  hidden: true,
})

export type ThreadStatus = 'open' | 'resolved'

/** Composing the todo status instead would give every thread a checkbox and
 *  put it in every todo query. Edit suggestions widen the options later. */
export const annotationStatusProp = seedProperty<ThreadStatus>({
  seedKey: 'system:annotations/property/status',
  revision: 1,
  name: 'annotation:status',
  preset: 'strict-enum',
  config: {options: [
    {value: 'open', label: 'open'},
    {value: 'resolved', label: 'resolved'},
  ]},
  defaultValue: 'open',
  changeScope: ChangeScope.BlockDefault,
})

export const annotationThreadType = seedType({
  seedKey: 'system:annotations/type/thread',
  revision: 1,
  id: THREAD_TYPE,
  label: 'Comment thread',
  hideFromCompletion: true,
  properties: [
    annotationTargetProp, annotationQuoteStartProp, annotationQuotePrefixProp,
    annotationQuoteSuffixProp, annotationStatusProp,
  ],
})

export const annotationPropertySeeds = [
  annotationTargetProp, annotationQuoteStartProp, annotationQuotePrefixProp,
  annotationQuoteSuffixProp, annotationStatusProp,
] as const

export type ThreadAnchor = {kind: 'block'} | ({kind: 'range'} & RangeAnchor)

const decoded = <T,>(data: BlockData, schema: {name: string; codec: {decode: (value: unknown) => T}; defaultValue: T}): T => {
  const value = data.properties[schema.name]
  return value === undefined ? schema.defaultValue : schema.codec.decode(value)
}

/** A thread root's anchor, read from its content and anchor properties. */
export const threadAnchorOf = (root: BlockData): ThreadAnchor =>
  root.content === ''
    ? {kind: 'block'}
    : {
      kind: 'range',
      quote: root.content,
      quoteStart: decoded(root, annotationQuoteStartProp),
      prefix: decoded(root, annotationQuotePrefixProp) ?? '',
      suffix: decoded(root, annotationQuoteSuffixProp) ?? '',
    }

export const threadTargetIdOf = (root: BlockData): string | undefined =>
  decoded(root, annotationTargetProp) || undefined

export const threadStatusOf = (root: BlockData): ThreadStatus => decoded(root, annotationStatusProp)
