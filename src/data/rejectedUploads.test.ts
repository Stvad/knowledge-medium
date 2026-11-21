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
  })

  it('requeues every row of a multi-row transaction under its transaction id and clears its quarantine', async () => {
    const {a, b} = await setup()
    const before = await queued()
    await rejectQueue()
    const [{txId}] = await listRejectedUploads(shared.db)

    await expect(retryRejectedUpload(shared.db, txId)).resolves.toEqual({txId, requeued: 2})
    expect(await queued()).toEqual(before)
    expect((await queued()).map(row => row.txId)).toEqual([txId, txId])
    expect(await rejectedCount()).toBe(0)
  })

  it('requeues a transaction that writes one block twice', async () => {
    const {repo} = createTestRepo({db: shared.db})
    await repo.tx(async tx => {
      const id = await tx.create({workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: 'first'})
      await tx.update(id, {content: 'second'})
    }, {scope: ChangeScope.BlockDefault})
    const before = await queued()
    expect(before.map(row => row.op)).toEqual(['PUT', 'PATCH'])
    await rejectQueue()

    await expect(retryRejectedUpload(shared.db, before[0].txId)).resolves.toEqual({txId: before[0].txId, requeued: 2})
    expect((await queued()).map(row => row.op)).toEqual(['PUT', 'PATCH'])
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

  /** A rejected content edit of `a`, alone in the quarantine, and the payload it carried. */
  const rejectContentEdit = async () => {
    const {repo, a} = await setup()
    await shared.db.execute('DELETE FROM ps_crud')
    await repo.tx(tx => tx.update(a, {content: 'rejected edit'}), {scope: ChangeScope.BlockDefault})
    const [patch] = await queued()
    await rejectQueue()
    return {repo, a, patch}
  }
  const quarantined = () => shared.db.getAll('SELECT * FROM ps_crud_rejected ORDER BY id')

  it('sends the stamps as they stand locally and keeps the version the edit was made against', async () => {
    const {repo, a, patch} = await rejectContentEdit()
    // A later accepted edit of another column, already uploaded.
    await repo.tx(tx => tx.move(a, {parentId: null, orderKey: 'a5'}), {scope: ChangeScope.BlockDefault})
    await shared.db.execute('DELETE FROM ps_crud')
    const local = await shared.db.get<{updated_at: number, user_updated_at: number}>(
      'SELECT updated_at, user_updated_at FROM blocks WHERE id = ?', [a])
    expect(local.updated_at).not.toBe(patch.data!.updated_at)

    await retryRejectedUpload(shared.db, patch.txId)
    expect(await queued()).toEqual([{...patch, data: {
      ...patch.data, updated_at: local.updated_at, user_updated_at: local.user_updated_at,
    }}])
  })

  it('refuses, and keeps the quarantine, when a later edit here changed a column it wrote', async () => {
    const {repo, a, patch} = await rejectContentEdit()
    await repo.tx(tx => tx.update(a, {content: 'later edit'}), {scope: ChangeScope.BlockDefault})
    await shared.db.execute('DELETE FROM ps_crud')
    const kept = await quarantined()

    await expect(retryRejectedUpload(shared.db, patch.txId))
      .rejects.toThrow(`block ${a} changed on this device since the rejected write (content`)
    expect(await quarantined()).toEqual(kept)
    expect(await queued()).toEqual([])
  })

  it('refuses when a download replaced a column it wrote', async () => {
    const {a, patch} = await rejectContentEdit()
    // Applied the way the sync drain writes: no tx_context source, so no upload.
    await shared.db.execute("UPDATE blocks SET content = 'server value' WHERE id = ?", [a])
    const kept = await quarantined()

    await expect(retryRejectedUpload(shared.db, patch.txId)).rejects.toThrow(`block ${a} changed on this device`)
    expect(await quarantined()).toEqual(kept)
  })

  it('retries a create whose row a later rejected edit changed, with the edit\'s value', async () => {
    const {repo, a} = await setup()
    await rejectQueue()
    await repo.tx(tx => tx.update(a, {content: 'edited'}), {scope: ChangeScope.BlockDefault})
    await rejectQueue()
    const [first, second] = await listRejectedUploads(shared.db)

    await retryRejectedUpload(shared.db, first.txId)
    expect((await queued()).find(row => row.id === a)).toMatchObject({op: 'PUT', data: {content: 'edited'}})
    await shared.db.execute('DELETE FROM ps_crud')
    await expect(retryRejectedUpload(shared.db, second.txId)).resolves.toEqual({txId: second.txId, requeued: 1})
  })

  it('refuses while the upload queue holds a write to one of its rows', async () => {
    const {repo, a, patch} = await rejectContentEdit()
    await repo.tx(tx => tx.move(a, {parentId: null, orderKey: 'a5'}), {scope: ChangeScope.BlockDefault})
    const kept = await quarantined()

    await expect(retryRejectedUpload(shared.db, patch.txId))
      .rejects.toThrow(`the upload queue holds a write to block ${a}`)
    expect(await quarantined()).toEqual(kept)
  })

  it('does not add a workspace the rejected payload lacked', async () => {
    const {a} = await setup()
    await shared.db.execute('DELETE FROM ps_crud')
    await shared.db.execute(`INSERT INTO ps_crud_rejected (original_id, tx_id, data, rejected_at) VALUES (1, 99, ?, 1)`,
      [JSON.stringify({op: 'PATCH', type: 'blocks', id: a, data: {content: 'first'}})])

    await retryRejectedUpload(shared.db, 99)
    expect(await queued()).toEqual([{txId: 99, op: 'PATCH', type: 'blocks', id: a, data: {content: 'first'}}])
  })

  it('requeues a payload that is not a block write unchanged', async () => {
    const {a} = await setup()
    await shared.db.execute('DELETE FROM ps_crud')
    const envelope = {op: 'DELETE', type: 'blocks', id: a}
    await shared.db.execute(`INSERT INTO ps_crud_rejected (original_id, tx_id, data, rejected_at) VALUES (1, 98, ?, 1)`,
      [JSON.stringify(envelope)])

    await retryRejectedUpload(shared.db, 98)
    expect(await queued()).toEqual([{txId: 98, ...envelope}])
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
