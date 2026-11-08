/** Initial property values for a newly tagged block. Per call they are
 *  `addType`'s `initialValues`; per type they are a same-tx processor from
 *  `typeInitialValuesProcessor`, so every path that adds the type gets them
 *  (`addType`, the `#` gesture, a raw `types` write, an import) while the type
 *  registry stays plain data. Both only fill properties the block does not
 *  already hold. */

import {
  defineSameTxProcessor,
  type AnyPropertyAssignment,
  type Tx,
} from '@/data/api'
import { addedTypes } from './properties'

/** `properties` plus each assignment's encoded value, for every assignment the
 *  bag holds under neither its own name nor the canonical name `tx` resolves it
 *  to (they differ for a handle to a renamed definition). A stored `null`
 *  counts as held. `null` when there was nothing to add. */
export const withAbsentPropertyValues = async (
  tx: Tx,
  blockId: string,
  properties: Readonly<Record<string, unknown>>,
  assignments: readonly AnyPropertyAssignment[],
): Promise<Record<string, unknown> | null> => {
  let next: Record<string, unknown> | null = null
  for (const {schema, value} of assignments) {
    if (Object.hasOwn(properties, schema.name)) continue
    const resolved = await tx.resolvePropertySchema(blockId, schema)
    if (Object.hasOwn(next ?? properties, resolved.name)) continue
    next ??= {...properties}
    next[resolved.name] = resolved.codec.encode(value)
  }
  return next
}

/** A same-tx processor that gives every block newly tagged `typeId` the
 *  `values` it does not already hold. One per type: its name derives from
 *  `typeId`. Contribute it through `sameTxProcessorsFacet`:
 *
 *    sameTxProcessorsFacet.of(typeInitialValuesProcessor(MY_TYPE, [
 *      propertyValue(stageProp, 'draft'),
 *    ]), {source: 'my-plugin'})
 *
 *  Whatever the same tx did to a value wins: one it wrote (`addType`'s
 *  `initialValues`) is held, one it explicitly unset stays unset. A block
 *  created already tagged counts as newly tagged, so re-creating a block from
 *  its stored bag fills values that bag lacked. Writes the raw bag rather than
 *  `tx.setProperty`, whose scope check would refuse a tag added in a tx of a
 *  different change scope than these properties'; `tx.update` materializes
 *  their field rows in a children-backed workspace, and stamps the write as a
 *  user edit even when the tagging write skipped metadata. */
export const typeInitialValuesProcessor = (
  typeId: string,
  values: readonly AnyPropertyAssignment[],
) => defineSameTxProcessor({
  name: `typeInitialValues:${typeId}`,
  watches: {kind: 'field', table: 'blocks', fields: ['properties']},
  rerunOnDirtyRows: true,
  apply: async (event, ctx) => {
    for (const row of event.changedRows) {
      // Defence in depth: tagging needs a live block, so a tombstoned `after` is unreachable today.
      if (row.after?.deleted || !addedTypes(row).includes(typeId)) continue
      const current = await ctx.tx.get(row.id)
      if (!current) continue
      const next = await withAbsentPropertyValues(ctx.tx, row.id, current.properties,
        values.filter(({schema}) => !ctx.wasPropertyUnset(row.id, schema.name)))
      if (next) await ctx.tx.update(row.id, {properties: next})
    }
  },
})
