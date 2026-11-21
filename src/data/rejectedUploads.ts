import {blockUploadJsonSql} from './internals/clientSchema'
import type {TxDb} from './internals/txEngine'

/** What the upload queue and its quarantine (`ps_crud_rejected`) hold. */
interface QueueDb {
  writeTransaction<R>(fn: (tx: TxDb) => Promise<R>): Promise<R>
  getAll<T>(sql: string, params?: unknown[]): Promise<T[]>
}

interface QuarantineRow {
  tx_id: number
  data: string
  error_code: string | null
  error_message: string | null
  rejected_at: number
}

interface Envelope {
  op: string
  type: string
  id: string
  data?: Record<string, unknown>
}

export interface RejectedUpload {
  txId: number
  rejectedAt: number
  errorCode: string | null
  errorMessage: string | null
  rows: {op: string, table: string, id: string, workspaceId: unknown, fields: string[]}[]
}

const SELECT_QUARANTINE_SQL =
  'SELECT tx_id, data, error_code, error_message, rejected_at FROM ps_crud_rejected'

/** One entry per refused transaction, oldest first: a transaction is the unit
 *  the server refused and the unit {@link retryRejectedUpload} requeues. */
export async function listRejectedUploads(db: QueueDb): Promise<RejectedUpload[]> {
  const byTx = new Map<number, RejectedUpload>()
  for (const row of await db.getAll<QuarantineRow>(`${SELECT_QUARANTINE_SQL} ORDER BY id`)) {
    const envelope = JSON.parse(row.data) as Envelope
    let entry = byTx.get(row.tx_id)
    if (!entry) {
      entry = {txId: row.tx_id, rejectedAt: row.rejected_at, errorCode: row.error_code,
        errorMessage: row.error_message, rows: []}
      byTx.set(row.tx_id, entry)
    }
    entry.rows.push({op: envelope.op, table: envelope.type, id: envelope.id,
      workspaceId: envelope.data?.workspace_id ?? null, fields: Object.keys(envelope.data ?? {})})
  }
  return [...byTx.values()]
}

/** Requeues every row of one rejected transaction under its transaction id and
 *  drops its quarantine records, in one write.
 *
 *  A block row is sent as it stands locally now, for the columns the rejected
 *  write named. The older payload would overwrite whatever reached the row since
 *  (a later edit here, or one downloaded from another device). `base_updated_at`
 *  keeps the version the edit was made against, so the server still sees drift.
 *
 *  It writes the queue directly, bypassing the Repo's read-only state; the
 *  caller decides whether this client may upload. A read-only tab is not
 *  refused here: its retry is rejected again and lands back in quarantine. */
export async function retryRejectedUpload(db: QueueDb, txId: number): Promise<{txId: number, requeued: number}> {
  return db.writeTransaction(async tx => {
    const rows = await tx.getAll<QuarantineRow>(`${SELECT_QUARANTINE_SQL} WHERE tx_id = ? ORDER BY id`, [txId])
    if (rows.length === 0) throw new Error(`No rejected transaction ${txId}`)
    for (const row of rows) {
      await tx.execute('INSERT INTO ps_crud (tx_id, data) VALUES (?, ?)', [txId, JSON.stringify(await asItStands(tx, row.data))])
    }
    await tx.execute('DELETE FROM ps_crud_rejected WHERE tx_id = ?', [txId])
    return {txId, requeued: rows.length}
  })
}

async function asItStands(tx: TxDb, raw: string): Promise<Envelope> {
  const envelope = JSON.parse(raw) as Envelope
  if (envelope.type !== 'blocks' || !envelope.data) return envelope
  const local = await tx.getOptional<{data: string}>(`SELECT ${blockUploadJsonSql('b')} AS data FROM blocks b WHERE b.id = ?`, [envelope.id])
  if (!local) throw new Error(`Cannot retry: block ${envelope.id} is not in this device's blocks`)
  const current = JSON.parse(local.data) as Record<string, unknown>
  const data = {...envelope.data}
  for (const key of Object.keys(data)) {
    if (Object.hasOwn(current, key)) data[key] = current[key]
  }
  return {...envelope, data}
}
