import type { PropertyKind } from '@/data/api'

/** Kinds the user can pick when adding a brand-new property by hand.
 *  Excludes `date` because JSON-shape inference can't recover dates on
 *  read. Reference-typed fields are schema-only because plugins need to
 *  declare target semantics before backlink projection treats strings
 *  as references. */
export type AddablePropertyKind =
  Exclude<PropertyKind, 'date' | 'object' | 'ref' | 'refList'> | 'object'

export const ADDABLE_PROPERTY_KINDS: ReadonlyArray<AddablePropertyKind> = [
  'string',
  'number',
  'boolean',
  'list',
  'object',
]

export const isAddablePropertyKind = (kind: PropertyKind): kind is AddablePropertyKind =>
  ADDABLE_PROPERTY_KINDS.includes(kind as AddablePropertyKind)

export const propertyKindLabel = (kind: PropertyKind): string => {
  switch (kind) {
    case 'string': return 'Plain'
    case 'list': return 'Options'
    case 'ref': return 'Reference'
    case 'refList': return 'Reference list'
    case 'date': return 'Date'
    case 'number': return 'Number'
    case 'boolean': return 'Checkbox'
    case 'object': return 'Object'
  }
}
