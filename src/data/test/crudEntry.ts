import type { CrudEntry, UpdateType } from '@powersync/common'

/** A `CrudEntry` as the SDK hands one to the upload connector. The SDK keeps
 *  its implementing class internal; this mirrors its fields and methods. */
export const crudEntry = (
  clientId: number,
  op: UpdateType,
  table: string,
  id: string,
  transactionId?: number,
  opData?: Record<string, unknown>,
): CrudEntry => {
  const toComparisonArray = () => [transactionId, clientId, op, table, id, opData, undefined, undefined]
  return {
    clientId, op, table, id, transactionId, opData, previousValues: undefined, metadata: undefined,
    toJSON: () => ({op_id: clientId, op, type: table, id, tx_id: transactionId, data: opData, old: undefined, metadata: undefined}),
    equals: entry => JSON.stringify(toComparisonArray()) === JSON.stringify(entry.toComparisonArray()),
    toComparisonArray,
  }
}
