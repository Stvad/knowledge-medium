/** What a new row in a query table is given so the query can find it: the
 *  parent its `childof=` term names, a type from each type term, and the value
 *  each `=` term names. Terms that name no single value (ranges, `!=`,
 *  presence, `under=`, an or-group) back-fill nothing. */
import { ChangeScope, type AnyPropertySchema } from '@/data/api'
import { createChild } from '@/data/mutators'
import type { Repo } from '@/data/repo'
import { impliedValue, type QueryTerm } from './parse'

export interface RowBackfill {
  /** The `childof=` parent; the host when the query names none. */
  readonly parentId: string | undefined
  readonly types: readonly string[]
  /** Values as a codec decodes them, ready for `setProperty`. */
  readonly values: ReadonlyArray<{readonly schema: AnyPropertySchema; readonly value: unknown}>
}

export const rowBackfill = (terms: readonly QueryTerm[]): RowBackfill => {
  let parentId: string | undefined
  const types: string[] = []
  const values: Array<{schema: AnyPropertySchema; value: unknown}> = []
  for (const term of terms) {
    if (term.kind === 'childof') parentId = term.target.id
    else if (term.kind === 'types' && !term.negated) types.push(term.types[0]!.id)
    else if (term.kind === 'compare' && term.op === 'eq') {
      const stored = impliedValue(term)
      // One value per property: a second `=` on it could not hold both.
      if (stored !== undefined && !values.some(entry => entry.schema.name === term.property.name)) {
        values.push({schema: term.property.schema, value: term.property.schema.codec.decode(stored)})
      }
    }
  }
  return {parentId, types: [...new Set(types)], values}
}

/** Creates the row, last under its parent, with everything the query implies,
 *  in one transaction and one undo step. */
export const createQueryRow = async (repo: Repo, hostId: string, backfill: RowBackfill): Promise<string> =>
  repo.tx(async tx => {
    const id = await tx.run(createChild, {parentId: backfill.parentId ?? hostId, position: {kind: 'last'}})
    for (const type of backfill.types) await repo.addTypeInTx(tx, id, type)
    for (const {schema, value} of backfill.values) await tx.setProperty(id, schema, value)
    return id
  }, {scope: ChangeScope.BlockDefault, description: 'new table row'})
