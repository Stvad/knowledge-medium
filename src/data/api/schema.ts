/** Boundary-validation schema. zod schemas conform to this structurally
 *  (`{ parse(input: unknown): T }`); plugins pick zod or any compatible
 *  validator (Valibot, Effect Schema). The data layer never needs zod's
 *  full surface — it only ever calls `.parse()`. */
export interface Schema<T> {
  parse(input: unknown): T
}
