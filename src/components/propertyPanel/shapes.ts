/** Property "type" vocabulary surfaced in panel UI. Codec types are
 *  open strings (`'string' | 'number' | 'list' | 'url' | 'ref' | …`),
 *  so `propertyTypeLabel` accepts arbitrary strings and falls back to
 *  the raw type for plugin-contributed types without a kernel preset.
 *
 *  v1's `AddablePropertyShape` selectable type list is preserved as a
 *  v1-compat shim for callers that still synthesize ad-hoc schemas
 *  (e.g. the panel's "change shape" path). The Phase 3 ValuePreset
 *  picker replaces this list with a presets-driven menu. */

export type AddablePropertyShape =
  | 'string'
  | 'number'
  | 'boolean'
  | 'list'
  | 'object'

export const ADDABLE_PROPERTY_SHAPES: ReadonlyArray<AddablePropertyShape> = [
  'string',
  'number',
  'boolean',
  'list',
  'object',
]

export const isAddablePropertyShape = (type: string): type is AddablePropertyShape =>
  (ADDABLE_PROPERTY_SHAPES as readonly string[]).includes(type)

const KERNEL_TYPE_LABELS: Record<string, string> = {
  string: 'Plain',
  list: 'Options',
  date: 'Date',
  number: 'Number',
  boolean: 'Checkbox',
  object: 'Object',
  url: 'URL',
  ref: 'Reference',
  refList: 'References',
}

export const propertyShapeLabel = (type: string): string =>
  KERNEL_TYPE_LABELS[type] ?? type
