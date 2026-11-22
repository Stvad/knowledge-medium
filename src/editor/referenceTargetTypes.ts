import { Facet } from '@codemirror/state'

/** Types a whole-value reference may target in this editor. */
export const referenceTargetTypes = Facet.define<readonly string[], readonly string[]>({
  combine: values => values[0] ?? [],
})
