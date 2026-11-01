import {ChangeScope, propertyValue, seedProperty, seedType, type BlockData, type BlockReference} from '@/data/api'
import {decodeRowProperty, safeDecodeRowProperty} from '@/data/rowProperty'
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

/** The `references` entry `annotationTargetProp` projects. A write that sets
 *  the target writes this too, so the thread is discoverable on its target as
 *  soon as the write commits, without waiting on the post-commit projection. */
export const threadTargetEdge = (targetId: string): BlockReference => ({
  id: targetId, alias: targetId, sourceField: annotationTargetProp.name,
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

/** `accepted` and `rejected` close an edit suggestion; `resolved` closes any
 *  thread. */
export type ThreadStatus = 'open' | 'resolved' | 'accepted' | 'rejected'

/** Composing the todo status instead would give every thread a checkbox and
 *  put it in every todo query. */
export const annotationStatusProp = seedProperty<ThreadStatus>({
  seedKey: 'system:annotations/property/status',
  revision: 1,
  name: 'annotation:status',
  preset: 'strict-enum',
  config: {options: [
    {value: 'open', label: 'open'},
    {value: 'resolved', label: 'resolved'},
    {value: 'accepted', label: 'accepted'},
    {value: 'rejected', label: 'rejected'},
  ]},
  defaultValue: 'open',
  changeScope: ChangeScope.BlockDefault,
})

/** An edit suggestion's new text for the quote; `threadSuggestionOf` says
 *  which threads are suggestions. There is no separate kind.
 *
 *  A property, not a child block of the root, which every reader of replies
 *  would have to skip. In a property-child-backed workspace its value row is
 *  a block, so links in it are references; before that they stay text until
 *  accepted. */
export const annotationReplacementProp = seedProperty({
  seedKey: 'system:annotations/property/replacement',
  revision: 1,
  name: 'annotation:replacement',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
  hidden: true,
})

/** Where a range thread's quote sat and what surrounded it; a whole-block
 *  thread carries none of them. */
export const anchorFieldProps = [annotationQuoteStartProp, annotationQuotePrefixProp, annotationQuoteSuffixProp] as const

export const anchorFieldValues = (anchor: RangeAnchor) => [
  propertyValue(annotationQuoteStartProp, anchor.quoteStart),
  propertyValue(annotationQuotePrefixProp, anchor.prefix),
  propertyValue(annotationQuoteSuffixProp, anchor.suffix),
]

export const annotationPropertySeeds = [
  annotationTargetProp, annotationQuoteStartProp, annotationQuotePrefixProp,
  annotationQuoteSuffixProp, annotationStatusProp, annotationReplacementProp,
] as const

export const annotationThreadType = seedType({
  seedKey: 'system:annotations/type/thread',
  revision: 1,
  id: THREAD_TYPE,
  label: 'Comment thread',
  hideFromCompletion: true,
  // The root already renders as a thread; a chip would say it twice.
  hideFromBlockDisplay: true,
  properties: [...annotationPropertySeeds],
})

export type ThreadAnchor = {kind: 'block'} | ({kind: 'range'} & RangeAnchor)

type RootRow = Pick<BlockData, 'content' | 'properties'>

const readAnchor = (root: RootRow): ThreadAnchor =>
  root.content === ''
    ? {kind: 'block'}
    : {
      kind: 'range',
      quote: root.content,
      quoteStart: decodeRowProperty(root, annotationQuoteStartProp),
      prefix: decodeRowProperty(root, annotationQuotePrefixProp) ?? '',
      suffix: decodeRowProperty(root, annotationQuoteSuffixProp) ?? '',
    }

/** A thread root's anchor, read from its content and anchor properties. A
 *  hand-edited property that no longer decodes leaves the quote with no
 *  position, which resolves as moved or stale rather than failing the read. */
export const threadAnchorOf = (root: RootRow): ThreadAnchor => {
  try {
    return readAnchor(root)
  } catch {
    return {kind: 'range', quote: root.content, quoteStart: undefined, prefix: '', suffix: ''}
  }
}

export const threadTargetIdOf = (root: RootRow): string | undefined =>
  safeDecodeRowProperty(root, annotationTargetProp) || undefined

export const threadStatusOf = (root: RootRow): ThreadStatus => decodeRowProperty(root, annotationStatusProp)

/** The stored replacement, if any. Empty counts as absent, and so does a
 *  hand-edited value that no longer decodes. */
export const threadReplacementOf = (root: RootRow): string | undefined =>
  safeDecodeRowProperty(root, annotationReplacementProp) || undefined

export interface ThreadSuggestion {
  anchor: RangeAnchor
  replacement: string
}

/** The edit a suggestion proposes, or null for any other thread: a range
 *  thread with a replacement is a suggestion, and a replacement on a
 *  whole-block thread is ignored, since there is no quote to replace. */
export const threadSuggestionOf = (root: RootRow): ThreadSuggestion | null => {
  const replacement = threadReplacementOf(root)
  const anchor = threadAnchorOf(root)
  return replacement !== undefined && anchor.kind === 'range' ? {anchor, replacement} : null
}

/** False for every closed status, and for one this build cannot decode, such
 *  as a later build's. */
export const threadIsOpen = (root: RootRow): boolean => {
  try {
    return threadStatusOf(root) === 'open'
  } catch {
    return false
  }
}
