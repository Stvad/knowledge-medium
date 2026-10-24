/**
 * PowerSync must not stage a server checkpoint that predates this device's own
 * acknowledged upload, though the upload triggers bypass its crud path: the
 * download hold note on them in `clientSchema.ts`.
 *
 * Drives the real PowerSync core (`powersync_control`, the Rust sync client's
 * entry point) with protocol lines, and the SDK's own upload completion, so the
 * gate under test is theirs.
 */
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import { BLOCK_STORAGE_COLUMNS, blockToRowParams, blockToSyncedRowParams } from '@/data/blockSchema'
import { SELECT_CLIENT_SCHEMA_TRIGGERS_SQL, triggerRecreateStatements } from '@/data/internals/clientSchema'
import type { BlockData } from '@/data/api'
import {
  INSERT_BLOCK_SQL,
  constMat,
  drainStagingWindowOnce,
  noKey,
  setupObserverTestDb,
} from './test/harness.js'

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

const { env, queuePendingUpload } = setupObserverTestDb()

/** The SDK's sync-client storage, which the database keeps internal. */
interface SyncClientStorage {
  control(op: string, payload: string | null): Promise<string>
  updateLocalTarget(cb: () => Promise<string>): Promise<boolean>
}
const storage = (): SyncClientStorage =>
  (env.db as unknown as { bucketStorageAdapter: SyncClientStorage }).bucketStorageAdapter

beforeEach(async () => {
  await env.db.writeTransaction(tx => tx.execute('SELECT powersync_clear(0)'))
  await storage().control('start', JSON.stringify({parameters: {}, schema: env.db.schema.toJSON()}))
})
afterEach(async () => { await storage().control('stop', null) })

const COLUMNS = BLOCK_STORAGE_COLUMNS.map(column => column.name)

/** A local write as `repo.tx` makes it: the upload triggers fire only with a
 *  non-NULL `tx_context.source`. */
const writeLocally = (sql: string, params: unknown[]) =>
  env.db.writeTransaction(async tx => {
    await tx.execute("UPDATE tx_context SET source = 'user', tx_seq = 1 WHERE id = 1")
    await tx.execute(sql, params)
    await tx.execute('UPDATE tx_context SET source = NULL, tx_seq = NULL WHERE id = 1')
  })
const createLocally = () => writeLocally(INSERT_BLOCK_SQL, blockToRowParams(created))
const EDIT_SQL = 'UPDATE blocks SET content = ?, updated_at = ?, user_updated_at = ? WHERE id = ?'
const EDIT_PARAMS = [edited.content, edited.updatedAt, edited.userUpdatedAt, edited.id]
const editLocally = () => writeLocally(EDIT_SQL, EDIT_PARAMS)

/** The SDK's upload loop once the connector has sent everything, in its two
 *  steps: complete each crud transaction, then ask for the write checkpoint
 *  covering them and tell the core when it took one. Checkpoints can arrive
 *  between the two, while the request is in flight. */
const completeUploads = async () => {
  for (let tx = await env.db.getNextCrudTransaction(); tx; tx = await env.db.getNextCrudTransaction()) {
    await tx.complete()
  }
}
const takeWriteCheckpoint = async (writeCheckpoint: string) => {
  if (await storage().updateLocalTarget(async () => writeCheckpoint)) {
    await storage().control('completed_upload', null)
  }
}
const acknowledgeUploads = async (writeCheckpoint: string) => {
  await completeUploads()
  await takeWriteCheckpoint(writeCheckpoint)
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
 *  carries only the ones this client has not downloaded. Resolves to the core's
 *  answer to the checkpoint's completion. */
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
    return line({checkpoint_complete: {last_op_id: lastOpId}})
  }
}

/** Held by the hold rather than the queue: the core declined for local data
 *  with `ps_crud` already empty. */
const expectHeldByHold = async (completion: string) => {
  expect(completion).toContain('Could not apply checkpoint due to local data')
  expect(await env.db.getAll('SELECT 1 FROM ps_crud')).toEqual([])
}

const drain = () => drainStagingWindowOnce(env.db, {getMaterializability: constMat('copy'), getCek: noKey})
const stagedContent = async () =>
  (await env.db.getOptional<{ content: string }>('SELECT content FROM blocks_synced WHERE id = ?', [created.id]))?.content
const localContent = async () =>
  (await env.db.get<{ content: string }>('SELECT content FROM blocks WHERE id = ?', [created.id])).content

describe('download gating on this device\'s own uploads', () => {
  it('holds a checkpoint cut before an acknowledged edit, so the drain cannot revert the edit', async () => {
    const serverCheckpoint = serverBucket()
    await createLocally()
    await acknowledgeUploads('1')
    await editLocally()
    await acknowledgeUploads('2')

    // The server's checkpoint holds the create but not yet the edit.
    await expectHeldByHold(await serverCheckpoint([putOp(1, created)], '1'))
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
    await env.db.execute(EDIT_SQL, EDIT_PARAMS)
    await queuePendingUpload(edited.id)
    await acknowledgeUploads('3')

    const foreign: BlockData = {...created, content: 'foreign', updatedAt: created.updatedAt + 100, updatedBy: 'user-2'}
    await expectHeldByHold(await serverCheckpoint([putOp(2, foreign)], null))
    expect(await stagedContent()).toBe(created.content)
    await drain()
    expect(await localContent()).toBe(edited.content)
  })

  it('holds an upload queued with no hold recorded, as a build before the hold left it', async () => {
    const serverCheckpoint = serverBucket()
    await createLocally()
    await acknowledgeUploads('1')
    await editLocally()
    await env.db.writeTransaction(tx => tx.execute("SELECT powersync_control('target_checkpoint_request_id', 0)"))
    await acknowledgeUploads('2')

    await expectHeldByHold(await serverCheckpoint([putOp(1, created)], '1'))
    expect(await stagedContent()).toBeUndefined()
  })

  it('keeps enqueueing on a database that still carries the 1.x hold trigger', async () => {
    onTestFinished(async () => { await env.db.execute('DROP TRIGGER IF EXISTS ps_crud_hold_downloads') })
    // Frozen: the trigger as the 1.x build installed it. Its target column is
    // gone from core schema 14.
    await env.db.execute(`
      CREATE TRIGGER ps_crud_hold_downloads AFTER INSERT ON ps_crud BEGIN
        DELETE FROM ps_buckets WHERE name = '$local';
        INSERT INTO ps_buckets(name, last_op, target_op) VALUES('$local', 0, 9223372036854775807);
      END
    `)
    const stored = await env.db.getAll<{name: string, sql: string}>(SELECT_CLIENT_SCHEMA_TRIGGERS_SQL)
    for (const stmt of triggerRecreateStatements(new Map(stored.map(row => [row.name, row.sql])))) {
      await env.db.execute(stmt)
    }

    await createLocally()
    expect(await env.db.getAll('SELECT 1 FROM ps_crud')).toHaveLength(1)
  })

  it('holds a checkpoint when the service hands out a write checkpoint below one already seen', async () => {
    const serverCheckpoint = serverBucket()
    await createLocally()
    await acknowledgeUploads('100')
    await serverCheckpoint([putOp(1, created)], '100')
    await editLocally()
    // The service's counter restarted: its storage was wiped, or this is a new instance.
    await acknowledgeUploads('3')

    await expectHeldByHold(await serverCheckpoint([putOp(2, created)], null))
    expect(await stagedContent()).toBe(created.content)

    await serverCheckpoint([putOp(3, edited)], '3')
    expect(await stagedContent()).toBe(edited.content)
  })

  it('publishes a checkpoint that arrived while the write checkpoint was in flight, once it is taken', async () => {
    const serverCheckpoint = serverBucket()
    await createLocally()
    await acknowledgeUploads('1')
    await editLocally()
    await completeUploads()

    await expectHeldByHold(await serverCheckpoint([putOp(1, created)], '1'))
    // Even the checkpoint covering the edit waits for the client to know that.
    await expectHeldByHold(await serverCheckpoint([putOp(2, edited)], '2'))
    expect(await stagedContent()).toBeUndefined()

    await takeWriteCheckpoint('2')
    expect(await stagedContent()).toBe(edited.content)
  })
})
