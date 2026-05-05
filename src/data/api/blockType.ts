import type { Tx } from './tx'
import type { AnyPropertySchema } from './propertySchema'
import type { Repo } from '../repo'

export interface TypeContribution {
  /** Stable id; matches the string written into `typesProp`. */
  readonly id: string
  /** Property schemas that apply to blocks of this type. */
  readonly properties?: ReadonlyArray<AnyPropertySchema>
  /** Optional human label for type pickers / property sections. */
  readonly label?: string
  /** Optional longer description for tooltips / section headers. */
  readonly description?: string
  /** Optional first-add setup hook, run inside the addType tx. */
  readonly setup?: TypeSetup
}

export interface TypeSetupContext {
  readonly tx: Tx
  readonly id: string
  readonly repo: Repo
  readonly types: ReadonlyMap<string, TypeContribution>
  readonly propertySchemas: ReadonlyMap<string, AnyPropertySchema>
}

export type TypeSetup = (ctx: TypeSetupContext) => void | Promise<void>

/** Identity helper for definition-site inference. Registration still
 *  happens through `typesFacet.of(...)`. */
export const defineBlockType = (def: TypeContribution): TypeContribution => def

