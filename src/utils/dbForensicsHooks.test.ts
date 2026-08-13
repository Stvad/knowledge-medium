import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetDbForensicsHooksForTest,
  computeSyncStall,
  stopSyncHealthWatch,
  SYNC_SAMPLE_INTERVAL_MS,
  SYNC_STALL_THRESHOLD_MS,
  watchForRuntimeCorruption,
  watchSyncHealth,
} from './dbForensicsHooks.js'
import type { DbForensics } from './dbForensics.js'
import {
  __resetLocalDbCorruptionSignalForTest,
  getLocalDbCorruptionSnapshot,
} from '@/data/localDbCorruptionSignal.js'
import {
  materializeQueueCountSql,
  rejectedQueueCountSql,
  uploadQueuePreviewCountSql,
  uploadQueueRowCountSql,
} from '@/data/syncQueueSql.js'

const stubForensics = () =>
  ({ captureCorruptionSnapshot: vi.fn().mockResolvedValue(null) }) as unknown as DbForensics

let stallEpisodeKeySeq = 0
const stubSyncForensics = () =>
  ({
    recordSyncSample: vi.fn().mockResolvedValue(undefined),
    recordStallEpisode: vi.fn().mockImplementation(async () => `stall:stub-${++stallEpisodeKeySeq}`),
    closeStallEpisode: vi.fn().mockResolvedValue(undefined),
    recordStallReconnectAttempt: vi.fn().mockResolvedValue(undefined),
    recordStallReconnectSkipped: vi.fn().mockResolvedValue(undefined),
  }) as unknown as DbForensics

// `watchSyncHealth`'s new required `reconnect` parameter — a fresh
// `vi.fn()` per test, matching the `stub*` factories' style above.
const stubReconnect = () => vi.fn().mockResolvedValue(undefined)

const zeroCounts = (): Map<string, number> => new Map([
  [uploadQueuePreviewCountSql, 0],
  [rejectedQueueCountSql, 0],
  [materializeQueueCountSql, 0],
  [uploadQueueRowCountSql, 0],
])

const defaultSyncStatus = () => ({
  connected: true,
  connecting: false,
  hasSynced: true,
  lastSyncedAt: Date.now(),
  dataFlowStatus: { uploading: false, downloading: false },
})

// A fake sync-health db: `getAll` is keyed by the exact SQL string (per the
// `counts` map), and `emit` re-reads `db.currentStatus` fresh — matching
// `watchSyncHealth`'s own convention of ignoring the statusChanged payload
// and always sampling live state (the counts always come from a live
// `db.getAll` anyway, so there's nothing to gain from threading the event's
// status object through).
const makeSyncDb = (
  currentStatus: Record<string, unknown> = defaultSyncStatus(),
  counts: Map<string, number> = zeroCounts(),
) => {
  let listener: (() => void) | null = null
  let liveStatus = currentStatus
  const db = {
    get currentStatus() { return liveStatus },
    getAll: vi.fn(async (sql: string) => [{ count: counts.get(sql) ?? 0 }]),
    registerListener: (l: { statusChanged?: (s: unknown) => void }) => {
      listener = () => l.statusChanged?.(liveStatus)
      return () => { listener = null }
    },
  } as unknown as Parameters<typeof watchSyncHealth>[0]
  const emit = (nextStatus?: Record<string, unknown>) => {
    if (nextStatus) liveStatus = nextStatus
    listener?.()
  }
  return { db, emit }
}

// A fake watch-db whose disposer actually detaches the listener, so `emit`
// after a dispose is a no-op — modelling PowerSync's registerListener contract.
const makeWatchDb = () => {
  let listener: ((s: unknown) => void) | null = null
  const db = {
    currentStatus: undefined,
    registerListener: (l: { statusChanged?: (s: unknown) => void }) => {
      listener = l.statusChanged ?? null
      return () => { listener = null }
    },
  } as unknown as Parameters<typeof watchForRuntimeCorruption>[0]
  return { db, emit: (s: unknown) => listener?.(s) }
}

afterEach(() => {
  __resetDbForensicsHooksForTest()
  __resetLocalDbCorruptionSignalForTest()
  vi.clearAllMocks()
})

describe('watchForRuntimeCorruption', () => {
  it('captures forensics AND routes to recovery on a runtime CORRUPT downloadError', () => {
    const forensics = stubForensics()
    const db = {
      currentStatus: {
        dataFlowStatus: {
          downloadError: new Error('powersync_control: internal SQLite call returned CORRUPT'),
        },
      },
    }
    watchForRuntimeCorruption(db, 'user-1', 'kmp-v6-user-1.db', forensics)

    expect(forensics.captureCorruptionSnapshot).toHaveBeenCalledOnce()
    expect(getLocalDbCorruptionSnapshot()?.userId).toBe('user-1')
  })

  it('does not route a benign (non-corruption) downloadError to recovery', () => {
    const forensics = stubForensics()
    const db = { currentStatus: { dataFlowStatus: { downloadError: new Error('network request failed') } } }
    watchForRuntimeCorruption(db, 'user-1', 'kmp-v6-user-1.db', forensics)

    expect(forensics.captureCorruptionSnapshot).not.toHaveBeenCalled()
    expect(getLocalDbCorruptionSnapshot()).toBeNull()
  })

  it('routes on a downloadError that arrives via a later statusChanged', () => {
    const forensics = stubForensics()
    type WatchDb = Parameters<typeof watchForRuntimeCorruption>[0]
    let emit: ((s: unknown) => void) | undefined
    const db = {
      currentStatus: undefined,
      registerListener: (l: { statusChanged?: (s: unknown) => void }) => {
        emit = l.statusChanged
        return () => {}
      },
    } as unknown as WatchDb
    watchForRuntimeCorruption(db, 'user-1', 'kmp-v6-user-1.db', forensics)
    expect(getLocalDbCorruptionSnapshot()).toBeNull()

    emit?.({ dataFlowStatus: { downloadError: new Error('database disk image is malformed') } })
    expect(getLocalDbCorruptionSnapshot()?.userId).toBe('user-1')
  })

  it('does not consume the one-shot capture on a benign powersync_control blip', () => {
    // A bare (non-CORRUPT) powersync_control sync failure must NOT capture — else
    // it would consume the one-shot and mask a later real-corruption snapshot.
    const forensics = stubForensics()
    const benign = { currentStatus: { dataFlowStatus: { downloadError: new Error('powersync_control: sync iteration failed') } } }
    watchForRuntimeCorruption(benign, 'user-1', 'kmp-v6-user-1.db', forensics)
    expect(forensics.captureCorruptionSnapshot).not.toHaveBeenCalled()
    expect(getLocalDbCorruptionSnapshot()).toBeNull()
  })

  it('does NOT route a benign HTTP sync error whose plain-object body echoes a corruption phrase', () => {
    // downloadError arrives as a plain object; a server 4xx body can contain
    // "…not a database…" etc. That must not yank a healthy session to reset.
    const forensics = stubForensics()
    const httpErr = { name: 'Error', message: 'HTTP Bad Request: table "x" is not a database table', stack: 'x' }
    const db = { currentStatus: { dataFlowStatus: { downloadError: httpErr } } }
    watchForRuntimeCorruption(db, 'user-1', 'kmp-v6-user-1.db', forensics)
    expect(forensics.captureCorruptionSnapshot).not.toHaveBeenCalled()
    expect(getLocalDbCorruptionSnapshot()).toBeNull()
  })

  it('captures the real message text from a plain-object (Comlink-serialized) downloadError, not "[object Object]"', () => {
    // A PowerSync `downloadError` crossing the wa-sqlite worker boundary
    // arrives as a plain object, not a real Error instance — this IS the
    // live shape (see localDbCorruption.ts's own note on the same failure
    // mode). The corruption MATCH still succeeds either way (it reads the
    // message chain independently), but the captured snapshot's `sql`
    // context must carry the real text, not `String(plainObject)` ===
    // "[object Object]" — the whole point of a forensic snapshot is to be
    // useful after the fact.
    const forensics = stubForensics()
    const plainDownloadError = { name: 'Error', message: 'disk image is malformed', stack: 'x' }
    const db = { currentStatus: { dataFlowStatus: { downloadError: plainDownloadError } } }
    watchForRuntimeCorruption(db, 'user-1', 'kmp-v6-user-1.db', forensics)

    expect(forensics.captureCorruptionSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ sql: { downloadError: 'disk image is malformed' } }),
    )
  })

  it('re-arms for a new user after an in-page account switch (disposes the stale listener)', () => {
    const forensics = stubForensics()
    const a = makeWatchDb()
    const b = makeWatchDb()
    watchForRuntimeCorruption(a.db, 'user-A', 'kmp-v6-user-A.db', forensics)
    // Switch to user B without reload — must dispose A's listener and rebind to B.
    watchForRuntimeCorruption(b.db, 'user-B', 'kmp-v6-user-B.db', forensics)

    // A's listener is disposed, so a stale event from user A's (disconnected) DB
    // never reaches us — user A's corruption can't be routed into user B's session.
    a.emit({ dataFlowStatus: { downloadError: new Error('database disk image is malformed') } })
    expect(getLocalDbCorruptionSnapshot()).toBeNull()

    // User B's corruption routes, tagged to user B.
    b.emit({ dataFlowStatus: { downloadError: new Error('database disk image is malformed') } })
    expect(getLocalDbCorruptionSnapshot()?.userId).toBe('user-B')
  })
})

describe('watchSyncHealth', () => {
  it('arming records an immediate sample; a statusChanged records another', async () => {
    const forensics = stubSyncForensics()
    const { db, emit } = makeSyncDb()

    watchSyncHealth(db, 'user-arm-1', stubReconnect(), forensics)
    await vi.waitFor(() => expect(forensics.recordSyncSample).toHaveBeenCalledTimes(1))

    emit({ ...defaultSyncStatus(), connected: false, connecting: true })
    await vi.waitFor(() => expect(forensics.recordSyncSample).toHaveBeenCalledTimes(2))
  })

  it('stall=true when pendingBlocks>0 and lastSyncedAt is older than the threshold', async () => {
    const forensics = stubSyncForensics()
    const staleLastSyncedAt = Date.now() - SYNC_STALL_THRESHOLD_MS - 60_000
    const counts = zeroCounts()
    counts.set(uploadQueuePreviewCountSql, 22)
    counts.set(uploadQueueRowCountSql, 22)
    const { db } = makeSyncDb(
      { ...defaultSyncStatus(), lastSyncedAt: staleLastSyncedAt },
      counts,
    )

    watchSyncHealth(db, 'user-stall-true', stubReconnect(), forensics)
    await vi.waitFor(() => expect(forensics.recordSyncSample).toHaveBeenCalledTimes(1))

    const sample = (forensics.recordSyncSample as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(sample.stall).toBe(true)
    expect(sample.pendingBlocks).toBe(22)
  })

  it('stall=false when the upload queue is empty, even with a stale lastSyncedAt', async () => {
    const forensics = stubSyncForensics()
    const staleLastSyncedAt = Date.now() - SYNC_STALL_THRESHOLD_MS - 60_000
    const { db } = makeSyncDb(
      { ...defaultSyncStatus(), lastSyncedAt: staleLastSyncedAt },
      zeroCounts(),
    )

    watchSyncHealth(db, 'user-stall-empty-queue', stubReconnect(), forensics)
    await vi.waitFor(() => expect(forensics.recordSyncSample).toHaveBeenCalledTimes(1))

    const sample = (forensics.recordSyncSample as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(sample.stall).toBe(false)
  })

  it('stall=false when lastSyncedAt is recent, even with a nonzero queue', async () => {
    const forensics = stubSyncForensics()
    const counts = zeroCounts()
    counts.set(uploadQueuePreviewCountSql, 22)
    counts.set(uploadQueueRowCountSql, 22)
    const { db } = makeSyncDb(
      { ...defaultSyncStatus(), lastSyncedAt: Date.now() },
      counts,
    )

    watchSyncHealth(db, 'user-stall-recent-sync', stubReconnect(), forensics)
    await vi.waitFor(() => expect(forensics.recordSyncSample).toHaveBeenCalledTimes(1))

    const sample = (forensics.recordSyncSample as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(sample.stall).toBe(false)
  })

  it('a getAll that rejects still records a sample with null counts', async () => {
    const forensics = stubSyncForensics()
    const db = {
      currentStatus: defaultSyncStatus(),
      getAll: async () => { throw new Error('boom') },
    }

    watchSyncHealth(db, 'user-getall-throws', stubReconnect(), forensics)
    await vi.waitFor(() => expect(forensics.recordSyncSample).toHaveBeenCalledTimes(1))

    const sample = (forensics.recordSyncSample as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(sample.pendingBlocks).toBeNull()
    expect(sample.rejected).toBeNull()
    expect(sample.materializing).toBeNull()
    expect(sample.pendingRows).toBeNull()
  })

  it('re-arming for a different user disposes the previous listener and clears the interval', async () => {
    vi.useFakeTimers()
    try {
      const forensics = stubSyncForensics()
      const a = makeSyncDb()
      const b = makeSyncDb()

      watchSyncHealth(a.db, 'user-rearm-A', stubReconnect(), forensics)
      await vi.advanceTimersByTimeAsync(0) // flush a's immediate sample
      expect(forensics.recordSyncSample).toHaveBeenCalledTimes(1)

      watchSyncHealth(b.db, 'user-rearm-B', stubReconnect(), forensics)
      await vi.advanceTimersByTimeAsync(0) // flush b's immediate sample
      expect(forensics.recordSyncSample).toHaveBeenCalledTimes(2)

      // a's listener is disposed — a stale statusChanged from a's (torn-down) db
      // must not produce a THIRD sample.
      a.emit()
      await vi.advanceTimersByTimeAsync(0)
      expect(forensics.recordSyncSample).toHaveBeenCalledTimes(2)

      // Only b's interval should still be armed: advancing by one full interval
      // must add exactly one sample (b's), not two (a's + b's).
      await vi.advanceTimersByTimeAsync(SYNC_SAMPLE_INTERVAL_MS)
      expect(forensics.recordSyncSample).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stall=true once the queue has been non-empty past the threshold even though lastSyncedAt stays fresh (uploads wedged, downloads healthy)', async () => {
    // The class of stall the old (lastSyncedAt-only) condition was blind to:
    // downloads keep checkpointing (lastSyncedAt never goes stale) while the
    // upload queue sits wedged. `currentStatus` is a getter so `lastSyncedAt`
    // reads as "just now" on every sample, no matter how much fake time passes.
    const forensics = stubSyncForensics()
    const counts = zeroCounts()
    counts.set(uploadQueuePreviewCountSql, 22)
    counts.set(uploadQueueRowCountSql, 22)
    const db = {
      get currentStatus() {
        return { ...defaultSyncStatus(), lastSyncedAt: Date.now() }
      },
      getAll: vi.fn(async (sql: string) => [{ count: counts.get(sql) ?? 0 }]),
    } as unknown as Parameters<typeof watchSyncHealth>[0]

    vi.useFakeTimers()
    try {
      watchSyncHealth(db, 'user-queue-old-fresh-sync', stubReconnect(), forensics)
      await vi.advanceTimersByTimeAsync(0) // flush the immediate sample
      const first = (forensics.recordSyncSample as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]
      expect(first.stall).toBe(false) // queue just became non-empty — not old yet

      await vi.advanceTimersByTimeAsync(SYNC_STALL_THRESHOLD_MS + SYNC_SAMPLE_INTERVAL_MS)
      const later = (forensics.recordSyncSample as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]
      expect(later.stall).toBe(true)
      expect(later.lastSyncedAt).not.toBeNull() // sanity: really was "fresh" the whole time
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens a stall episode on the not-stalled→stalled transition and does not reopen while it continues', async () => {
    const forensics = stubSyncForensics()
    const counts = zeroCounts()
    counts.set(uploadQueuePreviewCountSql, 22)
    counts.set(uploadQueueRowCountSql, 22)
    const staleLastSyncedAt = Date.now() - SYNC_STALL_THRESHOLD_MS - 60_000
    const { db, emit } = makeSyncDb({ ...defaultSyncStatus(), lastSyncedAt: staleLastSyncedAt }, counts)

    watchSyncHealth(db, 'user-episode-open', stubReconnect(), forensics)
    await vi.waitFor(() => expect(forensics.recordSyncSample).toHaveBeenCalledTimes(1))
    expect(forensics.recordStallEpisode).toHaveBeenCalledTimes(1)

    emit() // still stalled — a re-sample of the same state
    await vi.waitFor(() => expect(forensics.recordSyncSample).toHaveBeenCalledTimes(2))
    expect(forensics.recordStallEpisode).toHaveBeenCalledTimes(1) // not reopened
  })

  it('closes the stall episode with how it resolved on the stalled→not-stalled transition', async () => {
    const forensics = stubSyncForensics()
    const counts = zeroCounts()
    counts.set(uploadQueuePreviewCountSql, 22)
    counts.set(uploadQueueRowCountSql, 22)
    const staleLastSyncedAt = Date.now() - SYNC_STALL_THRESHOLD_MS - 60_000
    const { db, emit } = makeSyncDb({ ...defaultSyncStatus(), lastSyncedAt: staleLastSyncedAt }, counts)

    watchSyncHealth(db, 'user-episode-close', stubReconnect(), forensics)
    await vi.waitFor(() => expect(forensics.recordStallEpisode).toHaveBeenCalledTimes(1))
    const openedKey = await (forensics.recordStallEpisode as ReturnType<typeof vi.fn>).mock.results[0].value

    // Resolve: queue drains and sync catches up.
    counts.set(uploadQueuePreviewCountSql, 0)
    counts.set(uploadQueueRowCountSql, 0)
    emit({ ...defaultSyncStatus(), lastSyncedAt: Date.now() })

    await vi.waitFor(() => expect(forensics.closeStallEpisode).toHaveBeenCalledTimes(1))
    const [key, clearing] = (forensics.closeStallEpisode as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(key).toBe(openedKey)
    expect(clearing.clearedAt).toEqual(expect.any(Number))
    expect(clearing.connected).toBe(true)
    expect(clearing.pendingBlocks).toBe(0)
  })

  it('reads the real .message off a plain-object (Comlink-serialized) uploadError, not "[object Object]"', async () => {
    const forensics = stubSyncForensics()
    const plainUploadError = { name: 'Error', message: 'HTTP 401: invalid token', stack: 'x' }
    const { db } = makeSyncDb({
      ...defaultSyncStatus(),
      dataFlowStatus: { uploading: false, downloading: false, uploadError: plainUploadError },
    })

    watchSyncHealth(db, 'user-plain-upload-error', stubReconnect(), forensics)
    await vi.waitFor(() => expect(forensics.recordSyncSample).toHaveBeenCalledTimes(1))

    const sample = (forensics.recordSyncSample as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(sample.uploadError).toBe('HTTP 401: invalid token')
  })

  it('stamps the sample with the userId being watched', async () => {
    const forensics = stubSyncForensics()
    const { db } = makeSyncDb()
    watchSyncHealth(db, 'user-stamped', stubReconnect(), forensics)
    await vi.waitFor(() => expect(forensics.recordSyncSample).toHaveBeenCalledTimes(1))
    const sample = (forensics.recordSyncSample as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(sample.userId).toBe('user-stamped')
  })

  it('a failed count query (pendingBlocks=null) does not fabricate a stall resolution — retains the previous stall state and does not close the episode', async () => {
    const forensics = stubSyncForensics()
    const staleLastSyncedAt = Date.now() - SYNC_STALL_THRESHOLD_MS - 60_000
    const counts = zeroCounts()
    counts.set(uploadQueuePreviewCountSql, 22)
    counts.set(uploadQueueRowCountSql, 22)
    let failCounts = false
    let listener: (() => void) | null = null
    const db = {
      currentStatus: { ...defaultSyncStatus(), lastSyncedAt: staleLastSyncedAt },
      getAll: vi.fn(async (sql: string) => {
        if (failCounts) throw new Error('count query boom')
        return [{ count: counts.get(sql) ?? 0 }]
      }),
      registerListener: (l: { statusChanged?: () => void }) => {
        listener = () => l.statusChanged?.()
        return () => { listener = null }
      },
    } as unknown as Parameters<typeof watchSyncHealth>[0]
    const emit = () => listener?.()

    watchSyncHealth(db, 'user-null-count-retain', stubReconnect(), forensics)
    await vi.waitFor(() => expect(forensics.recordStallEpisode).toHaveBeenCalledTimes(1))

    failCounts = true
    emit()
    await vi.waitFor(() => expect(forensics.recordSyncSample).toHaveBeenCalledTimes(2))

    // The failed-count sample must still read as stalled (retained from the
    // previous sample) and must NOT have closed the episode — an unknown
    // count is not a resolution.
    const secondSample = (forensics.recordSyncSample as ReturnType<typeof vi.fn>).mock.calls[1][0]
    expect(secondSample.pendingBlocks).toBeNull()
    expect(secondSample.stall).toBe(true)
    expect(forensics.closeStallEpisode).not.toHaveBeenCalled()
  })

  it('a draining backlog (pendingBlocks decreasing over time) never trips the stall, even past the threshold', async () => {
    const forensics = stubSyncForensics()
    const reconnect = stubReconnect()
    let remaining = 500
    const db = {
      // lastSyncedAt is always "now" — isolates the test to the queue-age
      // dimension (a draining backlog), independent of `syncStale`.
      get currentStatus() {
        return { ...defaultSyncStatus(), lastSyncedAt: Date.now() }
      },
      getAll: vi.fn(async (sql: string) => {
        if (sql === uploadQueuePreviewCountSql || sql === uploadQueueRowCountSql) {
          return [{ count: remaining }]
        }
        return [{ count: 0 }]
      }),
    } as unknown as Parameters<typeof watchSyncHealth>[0]

    vi.useFakeTimers()
    try {
      watchSyncHealth(db, 'user-draining-backlog', reconnect, forensics)
      await vi.advanceTimersByTimeAsync(0)

      // Step the queue down over several minutes — past what would have been
      // the stall threshold if the clock never reset on progress — but never
      // let it reach zero (stays "non-empty the whole time").
      for (let i = 0; i < 15; i++) {
        remaining -= 30
        await vi.advanceTimersByTimeAsync(SYNC_SAMPLE_INTERVAL_MS)
      }

      const samples = (forensics.recordSyncSample as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0])
      expect(samples.length).toBeGreaterThan(10)
      expect(samples.every(s => s.stall === false)).toBe(true)
      expect(reconnect).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('serializes concurrent samples so a clearing sample cannot race the open-episode await and orphan the key', async () => {
    let resolveRecordStallEpisode: (key: string) => void = () => {}
    const recordStallEpisodePromise = new Promise<string>(resolve => { resolveRecordStallEpisode = resolve })
    const forensics = {
      recordSyncSample: vi.fn().mockResolvedValue(undefined),
      recordStallEpisode: vi.fn().mockReturnValue(recordStallEpisodePromise),
      closeStallEpisode: vi.fn().mockResolvedValue(undefined),
      recordStallReconnectAttempt: vi.fn().mockResolvedValue(undefined),
      recordStallReconnectSkipped: vi.fn().mockResolvedValue(undefined),
    } as unknown as DbForensics

    const counts = zeroCounts()
    counts.set(uploadQueuePreviewCountSql, 22)
    counts.set(uploadQueueRowCountSql, 22)
    const staleLastSyncedAt = Date.now() - SYNC_STALL_THRESHOLD_MS - 60_000
    const { db, emit } = makeSyncDb({ ...defaultSyncStatus(), lastSyncedAt: staleLastSyncedAt }, counts)

    watchSyncHealth(db, 'user-concurrent-race', stubReconnect(), forensics)
    await vi.waitFor(() => expect(forensics.recordStallEpisode).toHaveBeenCalledTimes(1))
    // Sample #1 is now suspended awaiting recordStallEpisode — openStallEpisodeKey
    // is still null. A second, CLEARING sample fires in that window (without
    // serialization it would race sample #1 and see the stale null key).
    counts.set(uploadQueuePreviewCountSql, 0)
    counts.set(uploadQueueRowCountSql, 0)
    emit({ ...defaultSyncStatus(), lastSyncedAt: Date.now() })

    // Give the (unserialized, in a regression) second sample's own promise
    // chain — four parallel `db.getAll` calls through `Promise.all` — plenty
    // of microtask ticks to run all the way to its `closeStallEpisode` call
    // BEFORE sample #1's still-pending `recordStallEpisode` await is
    // resolved below. This is pure microtask flushing (no real timers, fully
    // deterministic): nothing else in this test is time-dependent, and the
    // controlled `recordStallEpisodePromise` only ever resolves when this
    // test calls `resolveRecordStallEpisode` explicitly, so extra ticks
    // can't accidentally let sample #1 proceed early.
    for (let i = 0; i < 20; i++) await Promise.resolve()

    resolveRecordStallEpisode('stall:1000')
    await vi.waitFor(() => expect(forensics.recordSyncSample).toHaveBeenCalledTimes(2))

    expect(forensics.closeStallEpisode).toHaveBeenCalledTimes(1)
    expect(forensics.closeStallEpisode).toHaveBeenCalledWith('stall:1000', expect.anything())
  })

  it('collapses a burst of rapid statusChanged notifications into a bounded number of samples, not one per event', async () => {
    // Models PowerSync emitting statusChanged for every download-progress
    // update during an initial sync: many notifications firing while one
    // sample is still in flight must not each queue their own run.
    const forensics = stubSyncForensics()
    const { db, emit } = makeSyncDb()

    vi.useFakeTimers()
    try {
      watchSyncHealth(db, 'user-burst', stubReconnect(), forensics)
      // Fire a burst of statusChanged notifications synchronously, before the
      // very first (immediate) sample has had a chance to complete.
      for (let i = 0; i < 20; i++) emit()

      await vi.advanceTimersByTimeAsync(0) // flush the immediate sample + at most one coalesced re-run
      const afterBurst = (forensics.recordSyncSample as ReturnType<typeof vi.fn>).mock.calls.length
      // NOT one per burst event (that would be 21: 1 immediate + 20 emits).
      expect(afterBurst).toBeLessThan(3)

      // Fence: advance one full interval (a tick that DOES fire) and confirm
      // the count grows by exactly one more — proving the burst left nothing
      // extra queued up behind it (a stacked-N bug would show up here as a
      // jump of more than 1, since fake-timer flushing is FIFO).
      await vi.advanceTimersByTimeAsync(SYNC_SAMPLE_INTERVAL_MS)
      expect(forensics.recordSyncSample).toHaveBeenCalledTimes(afterBurst + 1)
    } finally {
      vi.useRealTimers()
    }
  })
})

// A db whose `currentStatus` stays fixed (queue non-empty, lastSyncedAt
// pinned to a stale past timestamp) for as long as the test advances fake
// time — the watchdog tests need the stall condition to hold indefinitely,
// not just for one sample.
const makeAlwaysStalledDb = () => {
  const counts = zeroCounts()
  counts.set(uploadQueuePreviewCountSql, 22)
  counts.set(uploadQueueRowCountSql, 22)
  const staleLastSyncedAt = Date.now() - SYNC_STALL_THRESHOLD_MS - 60_000
  return makeSyncDb({ ...defaultSyncStatus(), lastSyncedAt: staleLastSyncedAt }, counts)
}

describe('reconnect watchdog', () => {
  it('does not fire when the connection is healthy (no stall)', async () => {
    const forensics = stubSyncForensics()
    const reconnect = stubReconnect()
    const { db } = makeSyncDb() // defaults: connected, hasSynced, lastSyncedAt=now, empty queue

    watchSyncHealth(db, 'user-watchdog-healthy', reconnect, forensics)
    await vi.waitFor(() => expect(forensics.recordSyncSample).toHaveBeenCalledTimes(1))

    expect(reconnect).not.toHaveBeenCalled()
  })

  it('fires reconnect once on a sustained stall', async () => {
    const forensics = stubSyncForensics()
    const reconnect = stubReconnect()
    const { db } = makeAlwaysStalledDb()

    watchSyncHealth(db, 'user-watchdog-fire', reconnect, forensics)
    await vi.waitFor(() => expect(forensics.recordSyncSample).toHaveBeenCalledTimes(1))

    expect(reconnect).toHaveBeenCalledTimes(1)
    expect(reconnect).toHaveBeenCalledWith('user-watchdog-fire')
  })

  it('does not re-fire within the backoff window — a second stall sample inside it is a no-op', async () => {
    vi.useFakeTimers()
    try {
      const forensics = stubSyncForensics()
      const reconnect = stubReconnect()
      const { db } = makeAlwaysStalledDb()

      watchSyncHealth(db, 'user-watchdog-backoff', reconnect, forensics)
      await vi.advanceTimersByTimeAsync(0) // immediate sample fires the first attempt
      expect(reconnect).toHaveBeenCalledTimes(1)

      // Another sample well inside the 10min backoff window.
      await vi.advanceTimersByTimeAsync(SYNC_SAMPLE_INTERVAL_MS)
      expect(reconnect).toHaveBeenCalledTimes(1) // still just once
    } finally {
      vi.useRealTimers()
    }
  })

  it('escalates the backoff 10 → 20 → 40min, then caps at 60min', async () => {
    vi.useFakeTimers()
    try {
      const forensics = stubSyncForensics()
      const reconnect = stubReconnect()
      const { db } = makeAlwaysStalledDb()

      watchSyncHealth(db, 'user-watchdog-escalate', reconnect, forensics)
      await vi.advanceTimersByTimeAsync(0)
      expect(reconnect).toHaveBeenCalledTimes(1) // t=0

      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(reconnect).toHaveBeenCalledTimes(2) // t=10min: the 10min gap elapsed

      await vi.advanceTimersByTimeAsync(20 * 60_000)
      expect(reconnect).toHaveBeenCalledTimes(3) // t=30min: the 20min gap elapsed

      await vi.advanceTimersByTimeAsync(40 * 60_000)
      expect(reconnect).toHaveBeenCalledTimes(4) // t=70min: the 40min gap elapsed

      // From here the gap is capped at 60min — the PREVIOUS 40min step must
      // NOT be enough to re-fire.
      await vi.advanceTimersByTimeAsync(40 * 60_000)
      expect(reconnect).toHaveBeenCalledTimes(4) // t=110min: only 40min since the last attempt

      await vi.advanceTimersByTimeAsync(20 * 60_000) // completes the 60min cap gap
      expect(reconnect).toHaveBeenCalledTimes(5) // t=130min: 60min since the last attempt
    } finally {
      vi.useRealTimers()
    }
  })

  it('resets the backoff once the queue drains, so a NEW episode fires immediately again', async () => {
    vi.useFakeTimers()
    try {
      const forensics = stubSyncForensics()
      const reconnect = stubReconnect()
      const counts = zeroCounts()
      counts.set(uploadQueuePreviewCountSql, 22)
      counts.set(uploadQueueRowCountSql, 22)
      const staleLastSyncedAt = Date.now() - SYNC_STALL_THRESHOLD_MS - 60_000
      const { db, emit } = makeSyncDb({ ...defaultSyncStatus(), lastSyncedAt: staleLastSyncedAt }, counts)

      watchSyncHealth(db, 'user-watchdog-reset', reconnect, forensics)
      await vi.advanceTimersByTimeAsync(0)
      expect(reconnect).toHaveBeenCalledTimes(1)

      // Queue drains — stall clears.
      counts.set(uploadQueuePreviewCountSql, 0)
      counts.set(uploadQueueRowCountSql, 0)
      emit({ ...defaultSyncStatus(), lastSyncedAt: Date.now() })
      await vi.advanceTimersByTimeAsync(0)
      expect(reconnect).toHaveBeenCalledTimes(1) // no reconnect on a healthy sample

      // Stall returns, well inside what would have been the old 10min backoff
      // window — but this is a NEW episode, so it must fire immediately
      // rather than waiting out the previous episode's schedule.
      counts.set(uploadQueuePreviewCountSql, 22)
      counts.set(uploadQueueRowCountSql, 22)
      emit({ ...defaultSyncStatus(), lastSyncedAt: staleLastSyncedAt })
      await vi.advanceTimersByTimeAsync(0)
      expect(reconnect).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a throwing reconnect does not break sampling', async () => {
    const forensics = stubSyncForensics()
    const reconnect = vi.fn().mockRejectedValue(new Error('reconnect boom'))
    const { db, emit } = makeAlwaysStalledDb()

    // `sample()` in `watchSyncHealth` fires `sampleSyncHealth` as `void
    // sampleSyncHealth(...)` — best-effort discipline means nothing ever
    // attaches a `.catch()` to that promise, so if `runReconnectWatchdog`
    // let a rejection escape, it would surface as a genuine Node
    // `unhandledRejection`, not merely "the next sample didn't record" (the
    // sampler's setInterval/registerListener ticks keep firing regardless of
    // a rejected promise — that's not what "breaks the sampler" would even
    // look like from outside). Capture the event directly so a regression
    // fails this test by name instead of only showing up as vitest's
    // separate "Errors: N" run-level report.
    const unhandledReasons: unknown[] = []
    const onUnhandledRejection = (reason: unknown) => unhandledReasons.push(reason)
    process.on('unhandledRejection', onUnhandledRejection)

    try {
      watchSyncHealth(db, 'user-watchdog-throws', reconnect, forensics)
      await vi.waitFor(() => expect(reconnect).toHaveBeenCalledTimes(1))
      // The sample that triggered the (rejected) attempt was still recorded.
      expect(forensics.recordSyncSample).toHaveBeenCalledTimes(1)

      // Sampling keeps going on the next tick despite the throw.
      emit()
      await vi.waitFor(() => expect(forensics.recordSyncSample).toHaveBeenCalledTimes(2))
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }

    expect(unhandledReasons).toEqual([])
  })

  it('records each attempt (count + timestamp) onto the open stall episode', async () => {
    const forensics = stubSyncForensics()
    const reconnect = stubReconnect()
    const { db } = makeAlwaysStalledDb()

    watchSyncHealth(db, 'user-watchdog-record', reconnect, forensics)
    await vi.waitFor(() => expect(forensics.recordStallEpisode).toHaveBeenCalledTimes(1))
    const openedKey = await (forensics.recordStallEpisode as ReturnType<typeof vi.fn>).mock.results[0].value

    await vi.waitFor(() => expect(forensics.recordStallReconnectAttempt).toHaveBeenCalledTimes(1))
    expect(forensics.recordStallReconnectAttempt).toHaveBeenCalledWith(openedKey, expect.any(Number))
  })
})

describe('cross-tab reconnect lock', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('skips the reconnect (and records the skip) when another tab holds the cross-tab lock', async () => {
    const forensics = stubSyncForensics()
    const reconnect = stubReconnect()
    const { db } = makeAlwaysStalledDb()

    const request = vi.fn(async (_name: string, _opts: unknown, callback: (lock: null) => Promise<void>) => {
      await callback(null) // lock unavailable this round — another tab owns it
    })
    vi.stubGlobal('navigator', { locks: { request } })

    watchSyncHealth(db, 'user-watchdog-lock-contended', reconnect, forensics)
    await vi.waitFor(() => expect(forensics.recordStallReconnectSkipped).toHaveBeenCalledTimes(1))

    expect(reconnect).not.toHaveBeenCalled()
    expect(forensics.recordStallReconnectAttempt).not.toHaveBeenCalled()
  })

  it('reconnects normally when the cross-tab lock IS acquired', async () => {
    const forensics = stubSyncForensics()
    const reconnect = stubReconnect()
    const { db } = makeAlwaysStalledDb()

    const request = vi.fn(async (_name: string, _opts: unknown, callback: (lock: object) => Promise<void>) => {
      await callback({})
    })
    vi.stubGlobal('navigator', { locks: { request } })

    watchSyncHealth(db, 'user-watchdog-lock-acquired', reconnect, forensics)
    await vi.waitFor(() => expect(reconnect).toHaveBeenCalledTimes(1))
    expect(forensics.recordStallReconnectSkipped).not.toHaveBeenCalled()
  })

  it('a skipped attempt does not consume a backoff step — the same tab succeeds on the very next sample once the lock frees up', async () => {
    const forensics = stubSyncForensics()
    const reconnect = stubReconnect()
    const { db } = makeAlwaysStalledDb()

    let held = true
    const request = vi.fn(async (_n: string, _o: unknown, callback: (lock: object | null) => Promise<void>) => {
      await callback(held ? null : {})
    })
    vi.stubGlobal('navigator', { locks: { request } })

    vi.useFakeTimers()
    try {
      watchSyncHealth(db, 'user-watchdog-lock-then-free', reconnect, forensics)
      await vi.advanceTimersByTimeAsync(0)
      expect(reconnect).not.toHaveBeenCalled()
      expect(forensics.recordStallReconnectSkipped).toHaveBeenCalledTimes(1)

      // Lock frees up before the NEXT sample (one interval tick later). If
      // the skip had wrongly consumed a backoff step, this tick would still
      // be inside the 10min window and reconnect would stay at 0.
      held = false
      await vi.advanceTimersByTimeAsync(SYNC_SAMPLE_INTERVAL_MS)
      expect(reconnect).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('runs unguarded (still reconnects) when navigator.locks is unavailable', async () => {
    // The DEFAULT test environment already lacks navigator.locks (Node's
    // built-in `navigator` has no Web Locks API) — every other watchdog test
    // in this file already exercises this fallback implicitly. This test
    // pins the contract explicitly: an environment with no `locks` at all
    // must not silently stop reconnecting.
    const forensics = stubSyncForensics()
    const reconnect = stubReconnect()
    const { db } = makeAlwaysStalledDb()

    watchSyncHealth(db, 'user-watchdog-no-locks-api', reconnect, forensics)
    await vi.waitFor(() => expect(reconnect).toHaveBeenCalledTimes(1))
    expect(forensics.recordStallReconnectSkipped).not.toHaveBeenCalled()
  })
})

describe('stopSyncHealthWatch', () => {
  it('disposes the listener and clears the interval — a stale event/tick after stop produces no sample', async () => {
    vi.useFakeTimers()
    try {
      const forensics = stubSyncForensics()
      const { db, emit } = makeSyncDb()
      watchSyncHealth(db, 'user-stop', stubReconnect(), forensics)
      await vi.advanceTimersByTimeAsync(0)
      expect(forensics.recordSyncSample).toHaveBeenCalledTimes(1)

      stopSyncHealthWatch()

      emit() // stale statusChanged from the torn-down db
      await vi.advanceTimersByTimeAsync(SYNC_SAMPLE_INTERVAL_MS) // stale interval tick too
      expect(forensics.recordSyncSample).toHaveBeenCalledTimes(1) // unchanged
    } finally {
      vi.useRealTimers()
    }
  })

  it('allows re-arming for the SAME user afterward (watchSyncHealth is normally a no-op for an already-watched user, but stop clears that guard)', async () => {
    const forensics = stubSyncForensics()
    const { db } = makeSyncDb()
    watchSyncHealth(db, 'user-rearm-after-stop', stubReconnect(), forensics)
    await vi.waitFor(() => expect(forensics.recordSyncSample).toHaveBeenCalledTimes(1))

    stopSyncHealthWatch()
    watchSyncHealth(db, 'user-rearm-after-stop', stubReconnect(), forensics) // same user id
    await vi.waitFor(() => expect(forensics.recordSyncSample).toHaveBeenCalledTimes(2))
  })

  it('is a safe no-op when nothing is being watched', () => {
    expect(() => stopSyncHealthWatch()).not.toThrow()
  })
})

describe('computeSyncStall', () => {
  it('a decrease in pendingBlocks resets pendingSince — a draining backlog is not a stall', () => {
    const r1 = computeSyncStall({
      pendingBlocks: 100, pendingRows: 100, lastPendingBlocks: null, lastPendingRows: null,
      lastSyncedAt: null, pendingSince: null, now: 0, previousStall: false,
    })
    expect(r1).toEqual({ stall: false, pendingSince: 0 })

    // 11 minutes later, pendingBlocks has DECREASED (progress) — the clock
    // resets to `now` and there is still no stall, even past the threshold.
    const r2 = computeSyncStall({
      pendingBlocks: 80, pendingRows: 80, lastPendingBlocks: 100, lastPendingRows: 100,
      lastSyncedAt: null, pendingSince: r1.pendingSince, now: 11 * 60_000, previousStall: r1.stall,
    })
    expect(r2).toEqual({ stall: false, pendingSince: 11 * 60_000 })
  })

  it('a flat (non-decreasing) queue past the threshold DOES stall', () => {
    const r1 = computeSyncStall({
      pendingBlocks: 100, pendingRows: 100, lastPendingBlocks: null, lastPendingRows: null,
      lastSyncedAt: null, pendingSince: null, now: 0, previousStall: false,
    })
    const r2 = computeSyncStall({
      pendingBlocks: 100, pendingRows: 100, lastPendingBlocks: 100, lastPendingRows: 100,
      lastSyncedAt: null, pendingSince: r1.pendingSince, now: 11 * 60_000, previousStall: r1.stall,
    })
    expect(r2.stall).toBe(true)
  })

  it('a decrease in pendingRows alone (same pendingBlocks) also counts as progress', () => {
    const r1 = computeSyncStall({
      pendingBlocks: 5, pendingRows: 500, lastPendingBlocks: null, lastPendingRows: null,
      lastSyncedAt: null, pendingSince: null, now: 0, previousStall: false,
    })
    // Same distinct-block count (one block edited over and over) but the raw
    // row count has come down a lot — real progress draining that block's
    // backlog, even though `pendingBlocks` itself hasn't moved.
    const r2 = computeSyncStall({
      pendingBlocks: 5, pendingRows: 200, lastPendingBlocks: 5, lastPendingRows: 500,
      lastSyncedAt: null, pendingSince: r1.pendingSince, now: 11 * 60_000, previousStall: r1.stall,
    })
    expect(r2).toEqual({ stall: false, pendingSince: 11 * 60_000 })
  })

  it('pendingBlocks === null retains the previous stall verdict and leaves pendingSince untouched', () => {
    const r = computeSyncStall({
      pendingBlocks: null, pendingRows: null, lastPendingBlocks: 100, lastPendingRows: 100,
      lastSyncedAt: null, pendingSince: 12345, now: 99999, previousStall: true,
    })
    expect(r).toEqual({ stall: true, pendingSince: 12345 })
  })

  it('the queue draining to exactly zero clears pendingSince and is not a stall', () => {
    const r = computeSyncStall({
      pendingBlocks: 0, pendingRows: 0, lastPendingBlocks: 5, lastPendingRows: 5,
      lastSyncedAt: null, pendingSince: 0, now: 20 * 60_000, previousStall: true,
    })
    expect(r).toEqual({ stall: false, pendingSince: null })
  })
})
