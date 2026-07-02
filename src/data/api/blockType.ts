import type { AnyPropertySchema } from './propertySchema'

export interface TypeContribution {
  /** Stable id; matches the string written into `typesProp`. */
  readonly id: string
  /** Property schemas that apply to blocks of this type. */
  readonly properties?: ReadonlyArray<AnyPropertySchema>
  /** Optional human label for type pickers / property sections. */
  readonly label?: string
  /** Optional longer description for tooltips / section headers. */
  readonly description?: string
  /** Hide this type from a block's trailing `#type` tag-chip display.
   *  Display-only: the type stays taggable (pickers, `#` autocomplete)
   *  and manageable in the property panel. User-defined types set this
   *  via `block-type:hide-tag` on their definition block. */
  readonly hideTag?: boolean
  /** Optional CSS color for this type's tag chip (any value the
   *  browser's `color` property accepts). User-defined types set this
   *  via `block-type:color` on their definition block. */
  readonly color?: string
}

export interface TypeRegistrySnapshot {
  readonly types: ReadonlyMap<string, TypeContribution>
  readonly propertySchemas: ReadonlyMap<string, AnyPropertySchema>
}

/** Identity helper for definition-site inference. Registration still
 *  happens through `typesFacet.of(...)`. */
export const defineBlockType = (def: TypeContribution): TypeContribution => def
