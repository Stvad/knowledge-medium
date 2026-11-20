/**
 * Deliver server rows to a `createTestDb()` database through the REAL PowerSync
 * core (`powersync_control`, the Rust sync client's entry point), so the raw
 * table puts, the staging queue triggers and `has_synced` are the core's own —
 * and then re-read the sync status the way a boot does, so
 * `db.currentStatus.hasSynced` is the persisted answer rather than a stub.
 */
import type { PowerSyncDatabase } from '@powersync/node'
import { BLOCK_STORAGE_COLUMNS, blockToSyncedRowParams } from '@/data/blockSchema'
import type { BlockData } from '@/data/api'
import { WORKSPACE_COLUMNS, type WorkspaceRow } from '@/data/workspaceSchema'

const BUCKET = 'user_workspaces[]'

/** The SDK's sync-client storage and offline-status read, both internal. */
interface CoreAccess {
  bucketStorageAdapter: {control(op: string, payload: string | null): Promise<string>}
  resolveOfflineSyncStatus(): Promise<void>
}
const core = (db: PowerSyncDatabase): CoreAccess => db as unknown as CoreAccess

export interface ServerRow {
  readonly type: 'blocks_synced' | 'workspaces'
  readonly id: string
  readonly data: Record<string, unknown>
}

const rowData = (names: readonly string[], params: readonly unknown[]): Record<string, unknown> =>
  Object.fromEntries(names.map((name, i) => [name, params[i]]).filter(([name]) => name !== 'id'))

export const serverBlock = (block: BlockData): ServerRow => ({
  type: 'blocks_synced',
  id: block.id,
  data: rowData(BLOCK_STORAGE_COLUMNS.map(column => column.name), blockToSyncedRowParams(block)),
})

export const serverWorkspace = (row: WorkspaceRow): ServerRow => ({
  type: 'workspaces',
  id: row.id,
  data: rowData(WORKSPACE_COLUMNS.map(column => column.name), WORKSPACE_COLUMNS.map(c => row[c.name as keyof WorkspaceRow])),
})

/** Re-read the persisted sync status, as a reload's `init()` does. */
export const reloadSyncStatus = (db: PowerSyncDatabase): Promise<void> => core(db).resolveOfflineSyncStatus()

/** Forget every checkpoint (the rows it put are the caller's to reset). */
export const clearSyncState = async (db: PowerSyncDatabase): Promise<void> => {
  await db.writeTransaction(tx => tx.execute('SELECT powersync_clear(0)'))
  await reloadSyncStatus(db)
}

/** One server bucket: each delivery is a checkpoint covering every row so far
 *  that carries only the new ones. `complete: false` stops mid-download — the
 *  rows reach the oplog but no table. */
export const syncServer = (db: PowerSyncDatabase) => {
  const ops: {op_id: string; op: 'PUT'; object_type: string; object_id: string; checksum: number; data: string}[] = []
  const control = (op: string, payload: string | null) => core(db).bucketStorageAdapter.control(op, payload)
  const line = (value: unknown) => control('line_text', JSON.stringify(value))

  return async (rows: readonly ServerRow[], {complete = true}: {complete?: boolean} = {}): Promise<void> => {
    const after = ops.at(-1)?.op_id ?? null
    const fresh = rows.map((row, i) => ({
      op_id: String(ops.length + i + 1),
      op: 'PUT' as const,
      object_type: row.type,
      object_id: row.id,
      checksum: ops.length + i + 1,
      data: JSON.stringify(row.data),
    }))
    ops.push(...fresh)
    const lastOpId = ops.at(-1)!.op_id
    await control('start', JSON.stringify({parameters: {}, schema: db.schema.toJSON()}))
    try {
      await line({
        checkpoint: {
          last_op_id: lastOpId,
          write_checkpoint: null,
          buckets: [{bucket: BUCKET, checksum: ops.reduce((sum, op) => sum + op.checksum, 0), priority: 3, count: ops.length}],
        },
      })
      await line({data: {bucket: BUCKET, has_more: false, after, next_after: lastOpId, data: fresh}})
      if (complete) await line({checkpoint_complete: {last_op_id: lastOpId}})
    } finally {
      await control('stop', null)
    }
    await reloadSyncStatus(db)
  }
}
