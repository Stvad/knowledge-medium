import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  close: vi.fn(async () => {}),
  getPowerSyncDb: vi.fn(),
  deleteLocalSqliteDb: vi.fn(async () => {}),
  downloadBlob: vi.fn(),
  getRawSqliteDbBlob: vi.fn(),
}))

vi.mock('@/data/repoProvider', () => ({ getPowerSyncDb: mocks.getPowerSyncDb }))
vi.mock('./exportSqliteDb', () => ({
  deleteLocalSqliteDb: mocks.deleteLocalSqliteDb,
  downloadBlob: mocks.downloadBlob,
  getRawSqliteDbBlob: mocks.getRawSqliteDbBlob,
}))

import { downloadLocalDbBackup, resetLocalDatabase } from './localDbRecovery'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.close.mockResolvedValue(undefined)
  mocks.getPowerSyncDb.mockReturnValue({ close: mocks.close })
  mocks.deleteLocalSqliteDb.mockResolvedValue(undefined)
  mocks.getRawSqliteDbBlob.mockResolvedValue({
    blob: new Blob(['x'.repeat(10)]),
    filename: 'kmp-v6-u-export-1.db',
  })
})

describe('resetLocalDatabase', () => {
  it('closes the connection BEFORE deleting the local DB (release the handle first)', async () => {
    const order: string[] = []
    mocks.close.mockImplementationOnce(async () => void order.push('close'))
    mocks.deleteLocalSqliteDb.mockImplementationOnce(async () => void order.push('delete'))

    await resetLocalDatabase('u1')

    expect(mocks.getPowerSyncDb).toHaveBeenCalledWith('u1')
    expect(order).toEqual(['close', 'delete'])
    expect(mocks.deleteLocalSqliteDb).toHaveBeenCalledWith('u1')
  })

  it('still deletes the DB when closing the connection fails', async () => {
    mocks.close.mockRejectedValueOnce(new Error('already closed'))
    await expect(resetLocalDatabase('u1')).resolves.toBeUndefined()
    expect(mocks.deleteLocalSqliteDb).toHaveBeenCalledWith('u1')
  })
})

describe('downloadLocalDbBackup', () => {
  it('downloads the raw OPFS db and reports filename + size', async () => {
    const result = await downloadLocalDbBackup('u1')
    expect(mocks.getRawSqliteDbBlob).toHaveBeenCalledWith('u1')
    expect(mocks.downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'kmp-v6-u-export-1.db')
    expect(result).toEqual({ filename: 'kmp-v6-u-export-1.db', size: 10 })
  })
})
