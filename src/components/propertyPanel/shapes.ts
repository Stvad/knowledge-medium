import type { CodecShape } from '@/data/api'

/** Shapes the user can pick when adding a brand-new property by hand.
 *  Excludes `date` because JSON-shape inference can't recover dates on
 *  read. Reference-typed fields are schema-only because plugins need to
 *  declare target semantics before backlink projection treats strings
 *  as references. */
export type AddablePropertyShape = Exclude<CodecShape, 'date'>

export const ADDABLE_PROPERTY_SHAPES: ReadonlyArray<AddablePropertyShape> = [
  'string',
  'number',
  'boolean',
  'list',
  'object',
]

export const isAddablePropertyShape = (shape: CodecShape): shape is AddablePropertyShape =>
  ADDABLE_PROPERTY_SHAPES.includes(shape as AddablePropertyShape)

export const propertyShapeLabel = (shape: CodecShape): string => {
  switch (shape) {
    case 'string': return 'Plain'
    case 'list': return 'Options'
    case 'date': return 'Date'
    case 'number': return 'Number'
    case 'boolean': return 'Checkbox'
    case 'object': return 'Object'
  }
}
