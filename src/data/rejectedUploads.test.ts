// @vitest-environment node
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {ChangeScope} from '@/data/api'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {listRejectedUploads, retryRejectedUpload} from './rejectedUploads'

let shared: TestDb
beforeAll(async () => { shared = await createTestDb() })
afterAll(async () => { await shared.cleanup() })
beforeEach(async () => { await resetTestDb(shared.db) })

type Envelope = {op: string, type: string, id: string, data?: Record<string, unknown>}
const queued = async () => (await shared.db.getAll<{tx_id: number, data: string}>('SELECT tx_id, data FROM ps_crud ORDER BY id'))
  .map(row => ({txId: row.tx_id, ...JSON.parse(row.data) as Envelope}))
const rejectedCount = async () => (await shared.db.get<{n: number}>('SELECT count(*) AS n FROM ps_crud_rejected')).n

/** Moves the whole queue into quarantine, as the uploader does for a refused transaction. */
const rejectQueue = () => shared.db.writeTransaction(async tx => {
  await tx.execute(`INSERT INTO ps_crud_rejected (original_id, tx_id, data, error_code, error_message, rejected_at)
    SELECT id, tx_id, data, '42501', 'row-level security', 7 FROM ps_crud ORDER BY id`)
  await tx.execute('DELETE FROM ps_crud')
})

const setup = async () => {
  const {repo} = createTestRepo({db: shared.db})
  repo.setActiveWorkspaceId('ws-1')
  const [a, b] = await repo.tx(async tx => [
    await tx.create({workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: 'first'}),
    await tx.create({workspaceId: 'ws-1', parentId: null, orderKey: 'a1', content: 'second'}),
  ], {scope: ChangeScope.BlockDefault})
  return {repo, a, b}
}

describe('rejected uploads', () => {
  it('lists each rejected transaction once, oldest first, with its rows', async () => {
    const {repo, a, b} = await setup()
    await rejectQueue()
    await repo.tx(tx => tx.update(a, {content: 'edited'}), {scope: ChangeScope.BlockDefault})
    await rejectQueue()

    const listed = await listRejectedUploads(shared.db)
    expect(listed).toEqual([
      {txId: expect.any(Number), rejectedAt: 7, errorCode: '42501', errorMessage: 'row-level security', rows: [
        {op: 'PUT', table: 'blocks', id: a, workspaceId: 'ws-1', fields: expect.arrayContaining(['content'])},
        {op: 'PUT', table: 'blocks', id: b, workspaceId: 'ws-1', fields: expect.arrayContaining(['content'])},
      ]},
      {txId: expect.any(Number), rejectedAt: 7, errorCode: '42501', errorMessage: 'row-level security', rows: [
        {op: 'PATCH', table: 'blocks', id: a, workspaceId: 'ws-1', fields: expect.arrayContaining(['content'])},
      ]},
    ])
    expect(listed[0].txId).not.toBe(listed[1].txId)
  })

  it('requeues every row of a multi-row transaction under its transaction id and clears its quarantine', async () => {
    const {a, b} = await setup()
    const before = await queued()
    await rejectQueue()
    const [{txId}] = await listRejectedUploads(shared.db)

    await expect(retryRejectedUpload(shared.db, txId)).resolves.toEqual({txId, requeued: 2})
    expect(await queued()).toEqual(before)
    expect((await queued()).map(row => [row.txId, row.id])).toEqual([[txId, a], [txId, b]])
    expect(await rejectedCount()).toBe(0)
  })

  it('leaves other rejected transactions quarantined', async () => {
    const {repo, a} = await setup()
    await rejectQueue()
    await repo.tx(tx => tx.update(a, {content: 'edited'}), {scope: ChangeScope.BlockDefault})
    await rejectQueue()
    const [first, second] = await listRejectedUploads(shared.db)

    await retryRejectedUpload(shared.db, second.txId)
    expect(await listRejectedUploads(shared.db)).toEqual([first])
  })

  it('sends the row as it stands locally, so a later edit is not overwritten by the older payload', async () => {
    const {repo, a} = await setup()
    await repo.tx(tx => tx.update(a, {content: 'rejected edit'}), {scope: ChangeScope.BlockDefault})
    await shared.db.execute('DELETE FROM ps_crud WHERE json_extract(data, \'$.op\') = \'PUT\'')
    const [patch] = await queued()
    await rejectQueue()
    // Later accepted locally (and, in production, already uploaded).
    await repo.tx(tx => tx.update(a, {content: 'later edit'}), {scope: ChangeScope.BlockDefault})
    await shared.db.execute('DELETE FROM ps_crud')
    const local = await shared.db.get<{updated_at: number, user_updated_at: number}>(
      'SELECT updated_at, user_updated_at FROM blocks WHERE id = ?', [a])

    await retryRejectedUpload(shared.db, patch.txId)
    const [requeued] = await queued()
    expect(requeued).toEqual({...patch, data: {
      ...patch.data, content: 'later edit', updated_at: local.updated_at, user_updated_at: local.user_updated_at,
    }})
    // The version the edit was made against is the drift check's input; it stays.
    expect(requeued.data!.base_updated_at).toBe(patch.data!.base_updated_at)
  })

  it('does not add a workspace the rejected payload lacked', async () => {
    const {a} = await setup()
    await shared.db.execute('DELETE FROM ps_crud')
    await shared.db.execute(`INSERT INTO ps_crud_rejected (original_id, tx_id, data, rejected_at) VALUES (1, 99, ?, 1)`,
      [JSON.stringify({op: 'PATCH', type: 'blocks', id: a, data: {content: 'stale'}})])

    await retryRejectedUpload(shared.db, 99)
    expect(await queued()).toEqual([{txId: 99, op: 'PATCH', type: 'blocks', id: a, data: {content: 'first'}}])
  })

  it('refuses, and keeps the quarantine, when a row it wrote is gone locally', async () => {
    const {a} = await setup()
    await rejectQueue()
    const [{txId}] = await listRejectedUploads(shared.db)
    const before = await shared.db.getAll('SELECT * FROM ps_crud_rejected ORDER BY id')
    await shared.db.execute('DELETE FROM blocks WHERE id = ?', [a])

    await expect(retryRejectedUpload(shared.db, txId)).rejects.toThrow(`block ${a} is not in this device's blocks`)
    expect(await shared.db.getAll('SELECT * FROM ps_crud_rejected ORDER BY id')).toEqual(before)
    expect(await queued()).toEqual([])
  })

  it('refuses an unknown transaction id', async () => {
    await expect(retryRejectedUpload(shared.db, 12345)).rejects.toThrow('No rejected transaction 12345')
  })
})
