// @vitest-environment happy-dom
//
// Isolates `reconnectPowerSync` (the `sync.reconnect` primitive) from real
// PowerSync/OPFS/WASQLite — same mocking strategy as
// repoProvider.watchSyncHealth.test.ts (see that file's header for why each
// mock is there). The one addition here: `createPowerSyncConnector` is a
// spy (not a bare stub) so tests can assert `reconnectPowerSync` reuses the
// SAME construction call `ensurePowerSyncReady`'s connect step makes,
// instead of standing up a second connector.
import { afterEach, describe, expect, it, vi } from 'vitest'

const connectorHooks = vi.hoisted(() => ({
  createPowerSyncConnector: vi.fn(() => ({ marker: 'connector' })),
}))

vi.mock('@/utils/dbForensicsHooks.js', () => ({
  watchSyncHealth: vi.fn(),
  stopSyncHealthWatch: vi.fn(),
  watchForRuntimeCorruption: vi.fn(),
  recordForensicSessionStart: vi.fn(),
  captureDbOpenCorruption: vi.fn(),
}))

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
    // Real PowerSync flips `currentStatus.connected` once the stream comes
    // up; toggling it here (rather than leaving connect/disconnect as bare
    // no-ops) is what lets `reconnectPowerSync`'s new `waitForConnected`
    // fast-path resolve immediately in the tests below that don't care about
    // the timeout/failure path specifically.
    connect = async () => { this.currentStatus = { ...this.currentStatus, connected: true } }
    disconnect = async () => { this.currentStatus = { ...this.currentStatus, connected: false } }
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
  createPowerSyncConnector: connectorHooks.createPowerSyncConnector,
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
  scheduleDeepIdle: () => {},
}))

Object.defineProperty(navigator, 'storage', {
  configurable: true,
  value: { getDirectory: async () => ({}) },
})

const { ensurePowerSyncReady, reconnectPowerSync, getPowerSyncDb, RECONNECT_CONNECTED_TIMEOUT_MS } =
  await import('./repoProvider.js')

// Loosen the fake db's type at the call sites below rather than fighting the
// real `PowerSyncDatabase` type for a mock-only shape.
type FakeDb = {
  disconnect: () => Promise<void>
  connect: (connector: unknown) => Promise<void>
  currentStatus: Record<string, unknown>
  registerListener: (l: { statusChanged?: (s: Record<string, unknown>) => void }) => () => void
}
const fakeDb = (userId: string) => getPowerSyncDb(userId) as unknown as FakeDb

afterEach(() => {
  vi.clearAllMocks()
})

describe('reconnectPowerSync', () => {
  it('disconnects then connects, reusing the SAME connector construction ensurePowerSyncReady uses', async () => {
    await ensurePowerSyncReady('user-1', true)
    await reconnectPowerSync('user-1') // settle the initial connect queued by ensurePowerSyncReady first

    const db = fakeDb('user-1')
    const order: string[] = []
    db.disconnect = vi.fn(async () => { order.push('disconnect'); db.currentStatus = { ...db.currentStatus, connected: false } })
    db.connect = vi.fn(async () => { order.push('connect'); db.currentStatus = { ...db.currentStatus, connected: true } })
    connectorHooks.createPowerSyncConnector.mockClear()

    await reconnectPowerSync('user-1')

    expect(order).toEqual(['disconnect', 'connect'])
    expect(connectorHooks.createPowerSyncConnector).toHaveBeenCalledTimes(1)
    expect(connectorHooks.createPowerSyncConnector).toHaveBeenCalledWith(
      expect.objectContaining({ getWorkspaceMode: expect.any(Function), getCek: expect.any(Function) }),
    )
  })

  it('serializes concurrent reconnect calls through connectChain so disconnect/connect never overlap', async () => {
    await ensurePowerSyncReady('user-2', true)
    await reconnectPowerSync('user-2') // settle the initial connect first

    const db = fakeDb('user-2')
    let active = 0
    let overlapped = false
    const guarded = (setConnected: boolean) => vi.fn(async () => {
      active++
      if (active > 1) overlapped = true
      await Promise.resolve() // yield a tick so a real race would show up
      db.currentStatus = { ...db.currentStatus, connected: setConnected }
      active--
    })
    db.disconnect = guarded(false)
    db.connect = guarded(true)

    await Promise.all([reconnectPowerSync('user-2'), reconnectPowerSync('user-2')])

    expect(overlapped).toBe(false)
  })

  it('no-ops for a local-only session — must not start a remote connection', async () => {
    await ensurePowerSyncReady('user-local', false)
    const db = fakeDb('user-local')
    db.disconnect = vi.fn(async () => {})
    db.connect = vi.fn(async () => {})
    connectorHooks.createPowerSyncConnector.mockClear()

    await reconnectPowerSync('user-local')

    expect(db.disconnect).not.toHaveBeenCalled()
    expect(db.connect).not.toHaveBeenCalled()
    expect(connectorHooks.createPowerSyncConnector).not.toHaveBeenCalled()
  })

  it('no-ops when userId is not the currently-active session', async () => {
    // Both users get a REAL PowerSync db constructed (dbsByUser has an entry
    // for each) — the only thing distinguishing them is which one is
    // CURRENTLY active. Without a real db for the stale user, `!db` would
    // also no-op and the test wouldn't isolate the active-session guard.
    await ensurePowerSyncReady('user-not-active', true)
    await reconnectPowerSync('user-not-active') // settle its initial connect

    await ensurePowerSyncReady('user-active-2', true) // switches the active session
    await reconnectPowerSync('user-active-2') // settle its initial connect

    const staleDb = fakeDb('user-not-active')
    staleDb.disconnect = vi.fn(async () => {})
    staleDb.connect = vi.fn(async () => {})

    await reconnectPowerSync('user-not-active') // no longer the active session

    expect(staleDb.disconnect).not.toHaveBeenCalled()
    expect(staleDb.connect).not.toHaveBeenCalled()
  })

  it('rejects when connect() resolves but the connection never reaches "connected" within the bound (PowerSync swallows connection failures internally)', async () => {
    vi.useFakeTimers()
    try {
      await ensurePowerSyncReady('user-never-connects', true)
      await reconnectPowerSync('user-never-connects') // settle the initial connect

      const db = fakeDb('user-never-connects')
      // Models AbstractStreamingSyncImplementation.connect's
      // `connectInternal().catch(() => {})`: connect() resolves, but the
      // connection never actually comes up (stale token, network refused).
      db.disconnect = vi.fn(async () => { db.currentStatus = { ...db.currentStatus, connected: false } })
      db.connect = vi.fn(async () => {})

      const attempt = reconnectPowerSync('user-never-connects')
      let outcome: 'pending' | 'resolved' | 'rejected' = 'pending'
      attempt.then(() => { outcome = 'resolved' }, () => { outcome = 'rejected' })

      await vi.advanceTimersByTimeAsync(RECONNECT_CONNECTED_TIMEOUT_MS - 1)
      expect(outcome).toBe('pending')

      await vi.advanceTimersByTimeAsync(1)
      await expect(attempt).rejects.toThrow(/never reached "connected"/)
    } finally {
      vi.useRealTimers()
    }
  })
})
