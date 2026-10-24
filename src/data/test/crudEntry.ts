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

/** The entry the SDK reads back from a `ps_crud` row. */
export const crudEntryFromRow = (row: {id: string, tx_id: number, data: string}): CrudEntry => {
  const envelope = JSON.parse(row.data) as {op: UpdateType, type: string, id: string, data?: Record<string, unknown>}
  return crudEntry(Number.parseInt(row.id, 10), envelope.op, envelope.type, envelope.id, row.tx_id, envelope.data)
}
