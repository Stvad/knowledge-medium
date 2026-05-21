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
}

export interface TypeRegistrySnapshot {
  readonly types: ReadonlyMap<string, TypeContribution>
  readonly propertySchemas: ReadonlyMap<string, AnyPropertySchema>
}

/** Identity helper for definition-site inference. Registration still
 *  happens through `typesFacet.of(...)`. */
export const defineBlockType = (def: TypeContribution): TypeContribution => def
