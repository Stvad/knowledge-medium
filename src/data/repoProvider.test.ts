import { describe, expect, it } from 'vitest'
import { PowerSyncDatabase, WASQLiteVFS } from '@powersync/web'
import { webDatabaseOptions } from '@/data/repoProvider'
import { makeFakeAdapter } from '@/data/test/fakePowerSyncStack'

describe('webDatabaseOptions', () => {
  it('keeps multi-tab sync on where the SDK defaults it off, on the adapter we opened', async () => {
    // The SDK turns multi-tab off by default without SharedWorker, as on Safari.
    expect(typeof SharedWorker).toBe('undefined')
    const {adapter} = makeFakeAdapter()
    const db = new PowerSyncDatabase(webDatabaseOptions(
      {dbFilename: 'multi-tab.db', vfs: WASQLiteVFS.OPFSCoopSyncVFS, enableMultiTabs: true},
      adapter,
    ))
    // Init runs against the fake adapter and fails; only the constructor's choices are under test.
    const settled = db.waitForReady().catch(() => {})

    expect((db as unknown as {resolvedOpenOptions: {enableMultiTabs: boolean}}).resolvedOpenOptions.enableMultiTabs)
      .toBe(true)
    expect(db.database).toBe(adapter)
    await settled
  })
})
