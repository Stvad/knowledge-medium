import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  closePowerSyncDbIfOpen: vi.fn(async () => {}),
  deleteLocalSqliteDb: vi.fn(async () => {}),
  downloadBlob: vi.fn(),
  getRawSqliteDbBackup: vi.fn(),
}))

vi.mock('@/data/repoProvider', () => ({
  closePowerSyncDbIfOpen: mocks.closePowerSyncDbIfOpen,
}))
vi.mock('./exportSqliteDb', () => ({
  deleteLocalSqliteDb: mocks.deleteLocalSqliteDb,
  downloadBlob: mocks.downloadBlob,
  getRawSqliteDbBackup: mocks.getRawSqliteDbBackup,
}))

import { downloadLocalDbBackup, resetLocalDatabase } from './localDbRecovery'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.closePowerSyncDbIfOpen.mockResolvedValue(undefined)
  mocks.deleteLocalSqliteDb.mockResolvedValue(undefined)
  mocks.getRawSqliteDbBackup.mockResolvedValue({
    blob: new Blob(['x'.repeat(10)]),
    filename: 'kmp-v6-u-export-1.db',
    contents: ['kmp-v6-u.db'],
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
  it('releases the handle, then builds the backup and reports filename + size', async () => {
    const order: string[] = []
    mocks.closePowerSyncDbIfOpen.mockImplementationOnce(async () => void order.push('close'))
    mocks.getRawSqliteDbBackup.mockImplementationOnce(async () => {
      order.push('read')
      return { blob: new Blob(['x'.repeat(10)]), filename: 'kmp-v6-u-export-1.db', contents: ['kmp-v6-u.db'] }
    })

    const result = await downloadLocalDbBackup('u1')

    expect(order).toEqual(['close', 'read'])
    expect(mocks.closePowerSyncDbIfOpen).toHaveBeenCalledWith('u1')
    expect(mocks.downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'kmp-v6-u-export-1.db', undefined)
    expect(result).toEqual({ filename: 'kmp-v6-u-export-1.db', size: 10 })
  })

  it('passes the temp-zip cleanup through to downloadBlob when bundling siblings', async () => {
    const cleanup = vi.fn(async () => {})
    mocks.getRawSqliteDbBackup.mockResolvedValueOnce({
      blob: new Blob(['zipbytes']),
      filename: 'kmp-v6-u-recovery-1.zip',
      cleanup,
      contents: ['kmp-v6-u.db', 'kmp-v6-u.db-journal'],
    })

    await downloadLocalDbBackup('u1')

    expect(mocks.downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'kmp-v6-u-recovery-1.zip', cleanup)
  })

  it('still builds the backup when closing the connection fails', async () => {
    // A corrupt connection's close() re-awaits its own rejected init promise and
    // throws; the read-only getFile() does not need the handle released, so the
    // user must still get their bytes (do not deny the backup on a close error).
    mocks.closePowerSyncDbIfOpen.mockRejectedValueOnce(new Error('waitForReady rejected'))

    const result = await downloadLocalDbBackup('u1')

    expect(mocks.getRawSqliteDbBackup).toHaveBeenCalledWith('u1')
    expect(mocks.downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'kmp-v6-u-export-1.db', undefined)
    expect(result).toEqual({ filename: 'kmp-v6-u-export-1.db', size: 10 })
  })
})
