// @vitest-environment happy-dom
//
// Isolates the sync-health-watcher WIRING in `ensurePowerSyncReady` (the
// call to `watchSyncHealth`, gated behind `useRemoteSync` and `alreadyActive`)
// from the real PowerSync/OPFS/WASQLite machinery, which doesn't exist under
// vitest. Everything `initializePowerSyncDb` touches besides the fake
// PowerSyncDatabase itself is the REAL implementation (blockSchema,
// workspaceSchema, clientSchema migrations, syncedTableWriteGuard) — they're
// all idempotent "ensure this column/row exists" helpers that no-op cleanly
// against a fake db whose `getAll` returns `[]` and `getOptional` returns
// `null` (verified by reading each one: an empty PRAGMA table_info / a null
// backfill marker is exactly the "nothing to migrate yet" case they're
// written to handle). Only genuinely risky/heavy pieces are mocked:
// `@powersync/web` itself (no real WASQLite/OPFS here), `@/data/localSchema.js`
// (skips iterating every PLUGIN's backfill against the fake db — out of scope
// for this test), `@/extensions/staticDataExtensions.js` (the plugin
// composition root — heavy, and irrelevant once localSchema is mocked),
// `@/services/powersync.js` (avoid depending on real Supabase/env config),
// and `@/utils/scheduleIdle.js` (keeps ANALYZE off this test entirely).
import { afterEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  watchSyncHealth: vi.fn(),
  stopSyncHealthWatch: vi.fn(),
  watchForRuntimeCorruption: vi.fn(),
  recordForensicSessionStart: vi.fn(),
  captureDbOpenCorruption: vi.fn(),
}))

vi.mock('@/utils/dbForensicsHooks.js', () => hooks)

vi.mock('@powersync/web', () => {
  class FakePowerSyncDatabase {
    currentStatus: Record<string, unknown> = {
      hasSynced: true,
      connected: false,
      connecting: false,
      lastSyncedAt: null,
      dataFlowStatus: { uploading: false, downloading: false },
    }
    init = async () => {}
    execute = async () => ({})
    getOptional = async () => null
    getAll = async () => []
    registerListener = () => () => {}
    connect = async () => {}
    disconnect = async () => {}
    close = async () => {}
  }
  class FakeSchema {
    withRawTables() { return this }
  }
  class FakeWASQLiteOpenFactory {
    constructor(public opts: unknown) {}
  }
  return {
    PowerSyncDatabase: FakePowerSyncDatabase,
    Schema: FakeSchema,
    WASQLiteOpenFactory: FakeWASQLiteOpenFactory,
    WASQLiteVFS: { OPFSCoopSyncVFS: 'OPFSCoopSyncVFS' },
  }
})

vi.mock('@/services/powersync.js', () => ({
  createPowerSyncConnector: () => ({}),
  hasRemoteSyncConfig: true,
}))

vi.mock('@/sync/keys/keyStore.js', () => ({
  getWorkspaceKeyStore: () => ({}),
}))

vi.mock('@/data/localSchema.js', () => ({
  resolveLocalSchemaContributions: () => [],
  applyLocalSchemaContributions: async () => {},
}))

vi.mock('@/extensions/staticDataExtensions.js', () => ({
  staticDataExtensions: [],
}))

vi.mock('@/utils/scheduleIdle.js', () => ({
  CATCHUP_DEEP_IDLE: 0,
  // Never invokes its callback — keeps ANALYZE off this test's critical path
  // (mirrors the file's own reasoning for why it uses scheduleDeepIdle at all).
  scheduleDeepIdle: () => {},
}))

// `assertOpfsAvailable` just needs `navigator.storage.getDirectory()` to
// resolve without throwing.
Object.defineProperty(navigator, 'storage', {
  configurable: true,
  value: { getDirectory: async () => ({}) },
})

const { ensurePowerSyncReady } = await import('./repoProvider.js')

afterEach(() => {
  vi.clearAllMocks()
})

describe('ensurePowerSyncReady — sync-health watcher wiring', () => {
  it('does not arm the sync-health watcher for a local-only session', async () => {
    await ensurePowerSyncReady('user-local-only', false)

    expect(hooks.watchSyncHealth).not.toHaveBeenCalled()
    // Sanity: the rest of the forensic instrumentation still runs in
    // local-only mode — this isn't a global early-return skipping everything.
    expect(hooks.watchForRuntimeCorruption).toHaveBeenCalledOnce()
    expect(hooks.recordForensicSessionStart).toHaveBeenCalledOnce()
  })

  it('arms the sync-health watcher for a remote-sync session', async () => {
    await ensurePowerSyncReady('user-remote-sync', true)

    expect(hooks.watchSyncHealth).toHaveBeenCalledOnce()
    expect(hooks.watchSyncHealth).toHaveBeenCalledWith(
      expect.anything(), 'user-remote-sync', expect.any(Function),
    )
  })

  it('tears down the previous watcher when an in-page switch moves to a local-only session', async () => {
    await ensurePowerSyncReady('user-remote-then-local', true)
    expect(hooks.watchSyncHealth).toHaveBeenCalledOnce()
    expect(hooks.stopSyncHealthWatch).not.toHaveBeenCalled()

    // Same account, now local-only — models an in-page mode switch. Without
    // an explicit teardown call, the PREVIOUS remote session's watcher would
    // keep sampling the old db and filing into the still-active ring.
    await ensurePowerSyncReady('user-remote-then-local', false)
    expect(hooks.stopSyncHealthWatch).toHaveBeenCalledOnce()
  })
})
