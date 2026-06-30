import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  closePowerSyncDbIfOpen: vi.fn(async () => {}),
  deleteLocalSqliteDb: vi.fn(async () => {}),
  downloadBlob: vi.fn(),
  getRawSqliteDbBlob: vi.fn(),
}))

vi.mock('@/data/repoProvider', () => ({
  closePowerSyncDbIfOpen: mocks.closePowerSyncDbIfOpen,
}))
vi.mock('./exportSqliteDb', () => ({
  deleteLocalSqliteDb: mocks.deleteLocalSqliteDb,
  downloadBlob: mocks.downloadBlob,
  getRawSqliteDbBlob: mocks.getRawSqliteDbBlob,
}))

import { downloadLocalDbBackup, resetLocalDatabase } from './localDbRecovery'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.closePowerSyncDbIfOpen.mockResolvedValue(undefined)
  mocks.deleteLocalSqliteDb.mockResolvedValue(undefined)
  mocks.getRawSqliteDbBlob.mockResolvedValue({
    blob: new Blob(['x'.repeat(10)]),
    filename: 'kmp-v6-u-export-1.db',
  })
})

describe('resetLocalDatabase', () => {
  it('closes the connection BEFORE deleting the local DB (release the handle first)', async () => {
    const order: string[] = []
    mocks.closePowerSyncDbIfOpen.mockImplementationOnce(async () => void order.push('close'))
    mocks.deleteLocalSqliteDb.mockImplementationOnce(async () => void order.push('delete'))

    await resetLocalDatabase('u1')

    // Uses the peek-don't-construct close so we never open a fresh connection to
    // the file we're about to delete.
    expect(mocks.closePowerSyncDbIfOpen).toHaveBeenCalledWith('u1')
    expect(order).toEqual(['close', 'delete'])
    expect(mocks.deleteLocalSqliteDb).toHaveBeenCalledWith('u1')
  })

  it('still deletes the DB when closing the connection fails', async () => {
    mocks.closePowerSyncDbIfOpen.mockRejectedValueOnce(new Error('already closed'))
    await expect(resetLocalDatabase('u1')).resolves.toBeUndefined()
    expect(mocks.deleteLocalSqliteDb).toHaveBeenCalledWith('u1')
  })

  it('propagates a delete failure (caller must not reload onto a half-deleted DB)', async () => {
    mocks.deleteLocalSqliteDb.mockRejectedValueOnce(new Error('a journal file may be locked'))
    await expect(resetLocalDatabase('u1')).rejects.toThrow(/journal file may be locked/)
  })
})

describe('downloadLocalDbBackup', () => {
  it('releases the handle, then reads the raw OPFS db and reports filename + size', async () => {
    const order: string[] = []
    mocks.closePowerSyncDbIfOpen.mockImplementationOnce(async () => void order.push('close'))
    mocks.getRawSqliteDbBlob.mockImplementationOnce(async () => {
      order.push('read')
      return { blob: new Blob(['x'.repeat(10)]), filename: 'kmp-v6-u-export-1.db' }
    })

    const result = await downloadLocalDbBackup('u1')

    expect(order).toEqual(['close', 'read'])
    expect(mocks.closePowerSyncDbIfOpen).toHaveBeenCalledWith('u1')
    expect(mocks.downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'kmp-v6-u-export-1.db')
    expect(result).toEqual({ filename: 'kmp-v6-u-export-1.db', size: 10 })
  })
})
