/**
 * PowerSync must not stage a server checkpoint that predates this device's own
 * acknowledged upload.
 *
 * Drives the real PowerSync core (`powersync_control`, the Rust sync client's
 * entry point) with protocol lines, so the gate under test is the core's own:
 * it publishes a checkpoint only when `ps_crud` is empty AND the `$local`
 * bucket's `target_op` does not exceed its `last_op`. The second half is what
 * holds a download back between "upload acknowledged" and "the server's
 * checkpoint includes it", and it only engages if every enqueue raises
 * `$local.target_op` — PowerSync's own crud path does, and so must every
 * writer of ours that inserts into `ps_crud` directly.
 *
 * Without it the drain receives the older version as a fresh delivery and,
 * with nothing pending, applies it over the newer local row (#1226).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BLOCK_STORAGE_COLUMNS, blockToSyncedRowParams } from '@/data/blockSchema'
import { CLIENT_SCHEMA_NON_TRIGGER_STATEMENTS } from '@/data/internals/clientSchema'
import type { BlockData } from '@/data/api'
import { constMat, drainStagingWindowOnce, noKey, setupObserverTestDb } from './test/harness.js'

const BUCKET = 'workspace_data[]'

const created: BlockData = {
  id: 'b1',
  workspaceId: 'ws-plain',
  parentId: null,
  orderKey: 'a0',
  content: '',
  properties: {},
  references: [],
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
  userUpdatedAt: 1700000000000,
  createdBy: 'user-1',
  updatedBy: 'user-1',
  deleted: false,
}
const edited: BlockData = {...created, content: 'typed text', updatedAt: 1700000000463, userUpdatedAt: 1700000000463}

const { env } = setupObserverTestDb()

interface BucketStorage {
  control(op: string, payload: string | null): Promise<string>
  updateLocalTarget(cb: () => Promise<string>): Promise<boolean>
}
const storage = (): BucketStorage =>
  (env.db as unknown as { bucketStorageAdapter: BucketStorage }).bucketStorageAdapter

beforeEach(async () => {
  await env.db.execute('SELECT powersync_clear(0)')
  await storage().control('start', JSON.stringify({parameters: {}, schema: env.db.schema.toJSON()}))
})
afterEach(async () => { await storage().control('stop', null) })

const COLUMNS = BLOCK_STORAGE_COLUMNS.map(column => column.name)
const INSERT_SQL = `INSERT INTO blocks (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`

/** A local write as `repo.tx` makes it: the upload triggers fire only with a
 *  non-NULL `tx_context.source`. */
const writeLocally = (sql: string, params: unknown[]) =>
  env.db.writeTransaction(async tx => {
    await tx.execute("UPDATE tx_context SET source = 'user', tx_seq = 1 WHERE id = 1")
    await tx.execute(sql, params)
    await tx.execute('UPDATE tx_context SET source = NULL, tx_seq = NULL WHERE id = 1')
  })

/** The SDK's upload loop once the connector has sent everything: complete each
 *  crud transaction, ask for the write checkpoint covering them, and tell the
 *  core when it took one. */
const acknowledgeUploads = async (writeCheckpoint: string) => {
  for (let tx = await env.db.getNextCrudTransaction(); tx; tx = await env.db.getNextCrudTransaction()) {
    await tx.complete()
  }
  if (await storage().updateLocalTarget(async () => writeCheckpoint)) {
    await storage().control('completed_upload', null)
  }
}

type Op = ReturnType<typeof putOp>
const putOp = (opId: number, block: BlockData) => {
  const params = blockToSyncedRowParams(block)
  const columns = Object.fromEntries(
    COLUMNS.map((name, i) => [name, params[i]]).filter(([name]) => name !== 'id'),
  )
  return {
    op_id: String(opId), op: 'PUT', object_type: 'blocks_synced', object_id: block.id,
    checksum: opId, data: JSON.stringify(columns),
  }
}

/** The server's side of one bucket: each checkpoint covers every op so far and
 *  carries only the ones this client has not downloaded. */
const serverBucket = () => {
  const ops: Op[] = []
  const line = (value: unknown) => storage().control('line_text', JSON.stringify(value))
  return async (newOps: Op[], writeCheckpoint: string | null) => {
    const after = ops.at(-1)?.op_id ?? null
    ops.push(...newOps)
    const lastOpId = ops.at(-1)!.op_id
    await line({
      checkpoint: {
        last_op_id: lastOpId,
        write_checkpoint: writeCheckpoint,
        buckets: [{bucket: BUCKET, checksum: ops.reduce((sum, op) => sum + op.checksum, 0), priority: 3, count: ops.length}],
      },
    })
    await line({data: {bucket: BUCKET, has_more: false, after, next_after: lastOpId, data: newOps}})
    await line({checkpoint_complete: {last_op_id: lastOpId}})
  }
}

const drain = () => drainStagingWindowOnce(env.db, {getMaterializability: constMat('copy'), getCek: noKey})
const stagedContent = async () =>
  (await env.db.getOptional<{ content: string }>('SELECT content FROM blocks_synced WHERE id = ?', [created.id]))?.content
const localContent = async () =>
  (await env.db.get<{ content: string }>('SELECT content FROM blocks WHERE id = ?', [created.id])).content

describe('download gating on this device\'s own uploads', () => {
  it('holds a checkpoint cut before an acknowledged edit, so the drain cannot revert the edit', async () => {
    const serverCheckpoint = serverBucket()
    await writeLocally(INSERT_SQL, blockToSyncedRowParams(created))
    await acknowledgeUploads('1')
    await writeLocally(
      'UPDATE blocks SET content = ?, updated_at = ?, user_updated_at = ? WHERE id = ?',
      [edited.content, edited.updatedAt, edited.userUpdatedAt, edited.id],
    )
    await acknowledgeUploads('2')

    // The server's checkpoint holds the create but not yet the edit.
    await serverCheckpoint([putOp(1, created)], '1')
    expect(await stagedContent()).toBeUndefined()
    await drain()
    expect(await localContent()).toBe(edited.content)

    // Once a checkpoint covers the edit, it is published as usual.
    await serverCheckpoint([putOp(2, edited)], '2')
    expect(await stagedContent()).toBe(edited.content)
  })

  it('holds a re-queued upload, which enqueues without the block triggers', async () => {
    const serverCheckpoint = serverBucket()
    await serverCheckpoint([putOp(1, created)], null)
    await drain()
    // An edit whose upload was rejected: the local row holds it, the queue
    // does not, until a retry puts the envelope back.
    await env.db.execute(
      'UPDATE blocks SET content = ?, updated_at = ?, user_updated_at = ? WHERE id = ?',
      [edited.content, edited.updatedAt, edited.userUpdatedAt, edited.id],
    )
    await env.db.execute(
      "INSERT INTO ps_crud (tx_id, data) VALUES (1, json_object('op', 'PATCH', 'type', 'blocks', 'id', ?, 'data', json_object('content', ?)))",
      [edited.id, edited.content],
    )
    await acknowledgeUploads('3')

    const foreign: BlockData = {...created, content: 'foreign', updatedAt: created.updatedAt + 100, updatedBy: 'user-2'}
    await serverCheckpoint([putOp(2, foreign)], null)
    expect(await stagedContent()).toBe(created.content)
    await drain()
    expect(await localContent()).toBe(edited.content)
  })

  it('holds an upload a previous build queued, once this build boots', async () => {
    const serverCheckpoint = serverBucket()
    await writeLocally(INSERT_SQL, blockToSyncedRowParams(created))
    await acknowledgeUploads('1')
    await writeLocally(
      'UPDATE blocks SET content = ?, updated_at = ?, user_updated_at = ? WHERE id = ?',
      [edited.content, edited.updatedAt, edited.userUpdatedAt, edited.id],
    )
    // What a build without the hold left behind: the edit queued, no `$local`.
    await env.db.execute("DELETE FROM ps_buckets WHERE name = '$local'")
    for (const stmt of CLIENT_SCHEMA_NON_TRIGGER_STATEMENTS) await env.db.execute(stmt)
    await acknowledgeUploads('2')

    await serverCheckpoint([putOp(1, created)], '1')
    expect(await stagedContent()).toBeUndefined()
  })
})
