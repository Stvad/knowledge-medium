import {blockUploadJsonSql} from './internals/clientSchema'
import type {PowerSyncDb} from './internals/commitPipeline'
import type {TxDb} from './internals/txEngine'

type QueueDb = Pick<PowerSyncDb, 'writeTransaction' | 'getAll'>

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
  rows: {op: string, table: string, id: string, workspaceId: string | null, fields: string[]}[]
}

const SELECT_QUARANTINE_SQL =
  'SELECT tx_id, data, error_code, error_message, rejected_at FROM ps_crud_rejected'
const SELECT_LOCAL_PAYLOAD_SQL = `SELECT ${blockUploadJsonSql('b')} AS data FROM blocks b WHERE b.id = ?`
const SELECT_QUEUED_FOR_BLOCK_SQL = "SELECT 1 FROM ps_crud WHERE json_extract(data, '$.id') = ? LIMIT 1"
/** Every write moves these, so they say nothing about whose value a column holds. */
const STAMP_KEYS = new Set(['base_updated_at', 'updated_at', 'user_updated_at', 'updated_by'])

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
    const workspaceId = envelope.data?.workspace_id
    entry.rows.push({op: envelope.op, table: envelope.type, id: envelope.id,
      workspaceId: typeof workspaceId === 'string' ? workspaceId : null, fields: Object.keys(envelope.data ?? {})})
  }
  return [...byTx.values()]
}

/** Requeues every row of one rejected transaction under its transaction id and
 *  drops its quarantine records, in one write.
 *
 *  Only while the device still shows the rejected writes: every column a block
 *  row names must hold, locally, the value this device's latest rejected write
 *  gave it. Once something else reached the column (a later edit here, or a
 *  download, which nothing holds back for a quarantined row) neither value is
 *  safe to send: the stored one overwrites that change, the local one drops the
 *  rejected edit. Those are refused, and stay quarantined. Stamps are sent as
 *  they stand locally; `base_updated_at` keeps the version the edit was made
 *  against, so the server still sees drift.
 *
 *  Refused while the queue holds a write to one of its rows: the uploader would
 *  compact the two in the wrong order, a later create superseding the pending
 *  patch.
 *
 *  It writes the queue directly, past the Repo's read-only state, so the caller
 *  decides whether this client may upload. A read-only tab is not refused: the
 *  server rejects its retry again. Nor is a row's workspace checked: a host's
 *  state directory serves its one configured workspace. */
export async function retryRejectedUpload(db: QueueDb, txId: number): Promise<{txId: number, requeued: number}> {
  return db.writeTransaction(async tx => {
    const quarantine = await tx.getAll<QuarantineRow>(`${SELECT_QUARANTINE_SQL} ORDER BY id`)
    const rows = quarantine.filter(row => row.tx_id === txId)
    if (rows.length === 0) throw new Error(`No rejected transaction ${txId}`)
    const latestRejected = latestRejectedValues(quarantine)
    // Every row is judged before any is queued: a transaction can write one block twice.
    const envelopes: Envelope[] = []
    for (const row of rows) envelopes.push(await asRejected(tx, JSON.parse(row.data) as Envelope, latestRejected))
    for (const envelope of envelopes) {
      await tx.execute('INSERT INTO ps_crud (tx_id, data) VALUES (?, ?)', [txId, JSON.stringify(envelope)])
    }
    await tx.execute('DELETE FROM ps_crud_rejected WHERE tx_id = ?', [txId])
    return {txId, requeued: rows.length}
  })
}

/** Per block id and column, the value the newest quarantined write gave it. */
function latestRejectedValues(quarantine: readonly QuarantineRow[]): Map<string, Map<string, unknown>> {
  const latest = new Map<string, Map<string, unknown>>()
  for (const row of quarantine) {
    const {type, id, data} = JSON.parse(row.data) as Envelope
    if (type !== 'blocks' || !data) continue
    let columns = latest.get(id)
    if (!columns) latest.set(id, columns = new Map())
    for (const [key, value] of Object.entries(data)) columns.set(key, value)
  }
  return latest
}

async function asRejected(
  tx: TxDb, envelope: Envelope, latestRejected: Map<string, Map<string, unknown>>,
): Promise<Envelope> {
  if (envelope.type !== 'blocks' || !envelope.data) return envelope
  if (await tx.getOptional(SELECT_QUEUED_FOR_BLOCK_SQL, [envelope.id])) {
    throw new Error(`Cannot retry: the upload queue holds a write to block ${envelope.id}; retry once it drains`)
  }
  const local = await tx.getOptional<{data: string}>(SELECT_LOCAL_PAYLOAD_SQL, [envelope.id])
  if (!local) throw new Error(`Cannot retry: block ${envelope.id} is not in this device's blocks`)
  const current = JSON.parse(local.data) as Record<string, unknown>
  const rejected = latestRejected.get(envelope.id)
  const changed = Object.keys(envelope.data)
    .filter(key => !STAMP_KEYS.has(key) && current[key] !== rejected?.get(key))
  if (changed.length > 0) {
    throw new Error(`Cannot retry: block ${envelope.id} changed on this device since the rejected write (${changed.join(', ')})`)
  }
  const data = {...envelope.data}
  for (const key of Object.keys(data)) {
    if (key !== 'base_updated_at') data[key] = current[key]
  }
  return {...envelope, data}
}
