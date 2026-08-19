import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetDbForensicsHooksForTest,
  __setReconnectWatchdogEnabledForTest,
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
  uploadQueueEdgeSql,
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
    recordStallProgress: vi.fn().mockResolvedValue(undefined),
    recordStallSeenFlags: vi.fn().mockResolvedValue(undefined),
    recordStallReconnectAttempt: vi.fn().mockResolvedValue(undefined),
    recordStallReconnectSkipped: vi.fn().mockResolvedValue(undefined),
    recordStallReconnectWouldHaveFired: vi.fn().mockResolvedValue(undefined),
  }) as unknown as DbForensics

// `watchSyncHealth`'s `reconnect` parameter — a fresh `vi.fn()` per test,
// matching the `stub*` factories' style above.
const stubReconnect = () => vi.fn().mockResolvedValue(undefined)

// Mutable queue state shared by a fake sync-health db's `getAll`. Carries
// BOTH the old capped display counts (pendingBlocks/pendingRows/rejected/
// materializing) AND the new exact edge signal (lo/hi — see
// `uploadQueueEdgeSql`) so tests can move them independently, which is the
// whole point of item 3 (the verdict is driven by `lo`, not the counts).
interface QueueState {
  pendingBlocks: number
  pendingRows: number
  rejected: number
  materializing: number
  lo: number | null
  hi: number | null
}

const emptyQueueState = (): QueueState => ({
  pendingBlocks: 0, pendingRows: 0, rejected: 0, materializing: 0, lo: null, hi: null,
})

// Convenience for the common case where the old capped counts and the new
// exact edge signal move together (lo=1, hi=n — an unbroken run of ids from
// 1 to n). Tests that need to DECOUPLE them set `lo`/`hi` independently.
const nonEmptyQueueState = (n: number): QueueState => ({
  pendingBlocks: n, pendingRows: n, rejected: 0, materializing: 0, lo: 1, hi: n,
})

const defaultSyncStatus = () => ({
  connected: true,
  connecting: false,
  hasSynced: true,
  lastSyncedAt: Date.now(),
  dataFlowStatus: { uploading: false, downloading: false },
})

// A fake sync-health db: `getAll` is keyed by the exact SQL string against
// `queue`, and `emit` re-reads `db.currentStatus` fresh — matching
// `watchSyncHealth`'s own convention of sampling live state (the counts
// always come from a live `db.getAll` anyway). `queue` is returned so a test
// can mutate it in place (e.g. simulate a drain) without needing a fresh
// `emit` for pure count changes.
const makeSyncDb = (
  currentStatus: Record<string, unknown> = defaultSyncStatus(),
  queue: QueueState = emptyQueueState(),
) => {
  let listener: (() => void) | null = null
  let liveStatus = currentStatus
  const db = {
    get currentStatus() { return liveStatus },
    getAll: vi.fn(async (sql: string) => {
      if (sql === uploadQueuePreviewCountSql) return [{ count: queue.pendingBlocks }]
      if (sql === uploadQueueRowCountSql) return [{ count: queue.pendingRows }]
      if (sql === rejectedQueueCountSql) return [{ count: queue.rejected }]
      if (sql === materializeQueueCountSql) return [{ count: queue.materializing }]
      if (sql === uploadQueueEdgeSql) return [{ lo: queue.lo, hi: queue.hi }]
      return [{ count: 0 }]
    }),
    registerListener: (l: { statusChanged?: (s: unknown) => void }) => {
      listener = () => l.statusChanged?.(liveStatus)
      return () => { listener = null }
    },
  } as unknown as Parameters<typeof watchSyncHealth>[0]
  const emit = (nextStatus?: Record<string, unknown>) => {
    if (nextStatus) liveStatus = nextStatus
    listener?.()
  }
  return { db, emit, queue }
}

// A db whose `currentStatus` stays fixed (queue non-empty and never
// draining, lastSyncedAt pinned to a stale past timestamp) for as long as
// the test advances fake time — used wherever a test needs the stall
// condition to hold indefinitely once reached.
const makeAlwaysStalledDb = () => {
  const staleLastSyncedAt = Date.now() - SYNC_STALL_THRESHOLD_MS - 60_000
  return makeSyncDb({ ...defaultSyncStatus(), lastSyncedAt: staleLastSyncedAt }, nonEmptyQueueState(22))
}

// A watcher no longer stalls on sample #1 just because it observes a
// persisted-stale lastSyncedAt + a non-empty queue (item 1's fix) — reaching
// an ACTUAL stall now requires advancing past both the armedAt gate and the
// queue-age threshold. `SYNC_STALL_THRESHOLD_MS + SYNC_SAMPLE_INTERVAL_MS` is
// the smallest interval-aligned advance that lands strictly past the
// threshold (see computeSyncStall: the boundary sample at exactly the
// threshold is NOT yet `>`, so one more interval tick is needed).
const ARM_TO_STALL_MS = SYNC_STALL_THRESHOLD_MS + SYNC_SAMPLE_INTERVAL_MS

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

  it('captures the underlying cause, not the generic wrapper, when downloadError is rethrown with {cause}', () => {
    // The exact bug item 5 fixes, one level down: a sync-loop error rethrown
    // as `new Error('sync iteration failed', {cause: <the real one>})` must
    // not have its cause discarded — dbForensicsHooks.ts now delegates to
    // localDbCorruption.ts's hardened, exported `messageChainOf` instead of
    // hand-rolling a top-level-only copy.
    const forensics = stubForensics()
    const wrapped = new Error('sync iteration failed', {
      cause: new Error('database disk image is malformed'),
    })
    const db = { currentStatus: { dataFlowStatus: { downloadError: wrapped } } }
    watchForRuntimeCorruption(db, 'user-1', 'kmp-v6-user-1.db', forensics)

    expect(forensics.captureCorruptionSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: { downloadError: 'sync iteration failed\ndatabase disk image is malformed' },
      }),
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

  it('does NOT flag a stall on the very first sample after arming, even with a persisted-stale lastSyncedAt and a pending queue (item 1: the boot false-positive)', async () => {
    // The exact 2026-08-13-shaped scenario: closing the app with a queued
    // edit and reopening hours later makes `lastSyncedAt` (populated from
    // PERSISTED PowerSync state before any connection exists) read as
    // hours-old on sample #1, with a non-empty queue already present. That
    // must NOT read as a stall before this session has even had a chance to
    // try connecting.
    const forensics = stubSyncForensics()
    const staleLastSyncedAt = Date.now() - 10 * 60 * 60_000 // 10 hours old
    const { db } = makeSyncDb({ ...defaultSyncStatus(), lastSyncedAt: staleLastSyncedAt }, nonEmptyQueueState(22))

    watchSyncHealth(db, 'user-boot-false-positive', stubReconnect(), forensics)
    await vi.waitFor(() => expect(forensics.recordSyncSample).toHaveBeenCalledTimes(1))

    const sample = (forensics.recordSyncSample as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(sample.stall).toBe(false)
    expect(sample.pendingBlocks).toBe(22) // the queue itself is still faithfully reported
  })

  it('stall=true once the session has been armed AND the queue has been non-empty past the threshold', async () => {
    const forensics = stubSyncForensics()
    const { db } = makeAlwaysStalledDb()

    vi.useFakeTimers()
    try {
      watchSyncHealth(db, 'user-stall-true', stubReconnect(), forensics)
      await vi.advanceTimersByTimeAsync(ARM_TO_STALL_MS)

      const sample = (forensics.recordSyncSample as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]
      expect(sample.stall).toBe(true)
      expect(sample.pendingBlocks).toBe(22)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stall=false when the upload queue is empty, even with a stale lastSyncedAt', async () => {
    const forensics = stubSyncForensics()
    const staleLastSyncedAt = Date.now() - SYNC_STALL_THRESHOLD_MS - 60_000
    const { db } = makeSyncDb({ ...defaultSyncStatus(), lastSyncedAt: staleLastSyncedAt }, emptyQueueState())

    watchSyncHealth(db, 'user-stall-empty-queue', stubReconnect(), forensics)
    await vi.waitFor(() => expect(forensics.recordSyncSample).toHaveBeenCalledTimes(1))

    const sample = (forensics.recordSyncSample as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(sample.stall).toBe(false)
  })

  it('stall=false when lastSyncedAt is recent, even with a nonzero queue', async () => {
    const forensics = stubSyncForensics()
    const { db } = makeSyncDb({ ...defaultSyncStatus(), lastSyncedAt: Date.now() }, nonEmptyQueueState(22))

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

  it('opens a stall episode once the queue-age threshold is reached, and does not reopen while it continues', async () => {
    const forensics = stubSyncForensics()
    const { db, emit } = makeAlwaysStalledDb()

    vi.useFakeTimers()
    try {
      watchSyncHealth(db, 'user-episode-open', stubReconnect(), forensics)
      await vi.advanceTimersByTimeAsync(ARM_TO_STALL_MS)
      expect(forensics.recordStallEpisode).toHaveBeenCalledTimes(1)

      emit() // still stalled — a re-sample of the same state
      await vi.advanceTimersByTimeAsync(0)
      expect(forensics.recordStallEpisode).toHaveBeenCalledTimes(1) // not reopened
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes the stall episode with how it resolved once the queue actually drains to empty', async () => {
    const forensics = stubSyncForensics()
    const { db, emit, queue } = makeAlwaysStalledDb()

    vi.useFakeTimers()
    try {
      watchSyncHealth(db, 'user-episode-close', stubReconnect(), forensics)
      await vi.advanceTimersByTimeAsync(ARM_TO_STALL_MS)
      expect(forensics.recordStallEpisode).toHaveBeenCalledTimes(1)
      const openedKey = await (forensics.recordStallEpisode as ReturnType<typeof vi.fn>).mock.results[0].value

      // Resolve: the queue actually drains to empty (lo becomes null) and sync catches up.
      queue.pendingBlocks = 0
      queue.pendingRows = 0
      queue.lo = null
      queue.hi = null
      emit({ ...defaultSyncStatus(), lastSyncedAt: Date.now() })
      await vi.advanceTimersByTimeAsync(0)

      expect(forensics.closeStallEpisode).toHaveBeenCalledTimes(1)
      const [key, clearing] = (forensics.closeStallEpisode as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(key).toBe(openedKey)
      expect(clearing.clearedAt).toEqual(expect.any(Number))
      expect(clearing.connected).toBe(true)
      expect(clearing.pendingBlocks).toBe(0)
      // item 10 (3rd bullet): the clearing patch now carries enough to tell
      // recovery from data loss.
      expect(clearing.rejected).toBe(0)
      expect(clearing.pendingRows).toBe(0)
      expect(clearing.uploadError).toBeNull()
      expect(clearing.downloadError).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a dribbling queue (progress without fully draining) does NOT close the episode — records progress instead (item 2)', async () => {
    // The proven 2026-08-13-aftermath failure mode: a queue draining one
    // block at a time can make the raw `stall` verdict blip false (via
    // pendingSince resetting on progress) while remaining very much
    // non-empty. Closing on that fabricates a resolution per dribble.
    const forensics = stubSyncForensics()
    const { db, emit, queue } = makeAlwaysStalledDb()

    vi.useFakeTimers()
    try {
      watchSyncHealth(db, 'user-dribble', stubReconnect(), forensics)
      await vi.advanceTimersByTimeAsync(ARM_TO_STALL_MS)
      expect(forensics.recordStallEpisode).toHaveBeenCalledTimes(1)
      const openedKey = await (forensics.recordStallEpisode as ReturnType<typeof vi.fn>).mock.results[0].value

      // One block's worth of the queue drains (lo advances) — the queue is
      // STILL non-empty (hi still ahead of the new lo).
      queue.lo = 2
      queue.pendingBlocks = 21
      queue.pendingRows = 21
      emit({ ...defaultSyncStatus(), lastSyncedAt: Date.now() })
      await vi.advanceTimersByTimeAsync(0)

      expect(forensics.closeStallEpisode).not.toHaveBeenCalled()
      expect(forensics.recordStallProgress).toHaveBeenCalledWith(
        openedKey,
        expect.objectContaining({ pendingBlocks: 21 }),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('a failed edge query (loKnown=false) does not fabricate a stall resolution — retains the previous stall state and does not close the episode', async () => {
    const forensics = stubSyncForensics()
    const staleLastSyncedAt = Date.now() - SYNC_STALL_THRESHOLD_MS - 60_000
    let failQueries = false
    let listener: (() => void) | null = null
    const db = {
      currentStatus: { ...defaultSyncStatus(), lastSyncedAt: staleLastSyncedAt },
      getAll: vi.fn(async (sql: string) => {
        if (failQueries) throw new Error('count query boom')
        if (sql === uploadQueuePreviewCountSql || sql === uploadQueueRowCountSql) return [{ count: 22 }]
        if (sql === uploadQueueEdgeSql) return [{ lo: 1, hi: 22 }]
        return [{ count: 0 }]
      }),
      registerListener: (l: { statusChanged?: () => void }) => {
        listener = () => l.statusChanged?.()
        return () => { listener = null }
      },
    } as unknown as Parameters<typeof watchSyncHealth>[0]
    const emit = () => listener?.()

    vi.useFakeTimers()
    try {
      watchSyncHealth(db, 'user-null-count-retain', stubReconnect(), forensics)
      await vi.advanceTimersByTimeAsync(ARM_TO_STALL_MS)
      expect(forensics.recordStallEpisode).toHaveBeenCalledTimes(1)

      failQueries = true
      emit()
      await vi.advanceTimersByTimeAsync(0)

      // The failed-query sample must still read as stalled (retained from the
      // previous sample) and must NOT have closed the episode — an unknown
      // edge is not a resolution.
      const lastSample = (forensics.recordSyncSample as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]
      expect(lastSample.pendingBlocks).toBeNull()
      expect(lastSample.stall).toBe(true)
      expect(forensics.closeStallEpisode).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a draining backlog (lo genuinely advancing over time) never trips the stall, even past the threshold', async () => {
    const forensics = stubSyncForensics()
    const reconnect = stubReconnect()
    let lo = 1
    const db = {
      // lastSyncedAt is always "now" — isolates the test to the queue-age
      // dimension (a draining backlog), independent of `syncStale`.
      get currentStatus() {
        return { ...defaultSyncStatus(), lastSyncedAt: Date.now() }
      },
      getAll: vi.fn(async (sql: string) => {
        if (sql === uploadQueuePreviewCountSql || sql === uploadQueueRowCountSql) return [{ count: 500 }]
        if (sql === uploadQueueEdgeSql) return [{ lo, hi: lo + 5000 }]
        return [{ count: 0 }]
      }),
    } as unknown as Parameters<typeof watchSyncHealth>[0]

    vi.useFakeTimers()
    try {
      watchSyncHealth(db, 'user-draining-backlog', reconnect, forensics)
      await vi.advanceTimersByTimeAsync(0)

      // Step `lo` up over several minutes — past what would have been the
      // stall threshold if the clock never reset on progress — but never let
      // it stop advancing (queue never "finishes draining" to null either).
      for (let i = 0; i < 15; i++) {
        lo += 30
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

  it('the stall verdict is driven by lo advancing, NOT by the (still capped, display-only) pendingBlocks/pendingRows counts (item 3)', async () => {
    const forensics = stubSyncForensics()
    let pendingBlocks = 5
    const db = {
      get currentStatus() {
        return { ...defaultSyncStatus(), lastSyncedAt: Date.now() }
      },
      getAll: vi.fn(async (sql: string) => {
        // pendingBlocks/pendingRows DECREASE every sample — would have read
        // as "progress" under the old capped-count heuristic — while `lo`
        // stays completely FLAT (no batch actually drained).
        if (sql === uploadQueuePreviewCountSql || sql === uploadQueueRowCountSql) {
          pendingBlocks = Math.max(0, pendingBlocks - 1)
          return [{ count: pendingBlocks }]
        }
        if (sql === uploadQueueEdgeSql) return [{ lo: 1, hi: 999 }]
        return [{ count: 0 }]
      }),
    } as unknown as Parameters<typeof watchSyncHealth>[0]

    vi.useFakeTimers()
    try {
      watchSyncHealth(db, 'user-lo-drives-verdict', stubReconnect(), forensics)
      await vi.advanceTimersByTimeAsync(ARM_TO_STALL_MS)

      const lastSample = (forensics.recordSyncSample as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]
      expect(lastSample.stall).toBe(true) // stalled despite pendingBlocks visibly shrinking every sample
    } finally {
      vi.useRealTimers()
    }
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

  it('records the underlying cause, not the generic wrapper, for an uploadError rethrown with {cause} (item 5)', async () => {
    const forensics = stubSyncForensics()
    const wrapped = new Error('sync iteration failed', { cause: new Error('HTTP 401: invalid token') })
    const { db } = makeSyncDb({
      ...defaultSyncStatus(),
      dataFlowStatus: { uploading: false, downloading: false, uploadError: wrapped },
    })

    watchSyncHealth(db, 'user-wrapped-upload-error', stubReconnect(), forensics)
    await vi.waitFor(() => expect(forensics.recordSyncSample).toHaveBeenCalledTimes(1))

    const sample = (forensics.recordSyncSample as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(sample.uploadError).toBe('sync iteration failed\nHTTP 401: invalid token')
  })

  it('stamps the sample with the userId being watched', async () => {
    const forensics = stubSyncForensics()
    const { db } = makeSyncDb()
    watchSyncHealth(db, 'user-stamped', stubReconnect(), forensics)
    await vi.waitFor(() => expect(forensics.recordSyncSample).toHaveBeenCalledTimes(1))
    const sample = (forensics.recordSyncSample as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(sample.userId).toBe('user-stamped')
  })

  it('serializes concurrent samples so a clearing sample cannot race the open-episode await and orphan the key', async () => {
    let resolveRecordStallEpisode: (key: string) => void = () => {}
    const recordStallEpisodePromise = new Promise<string>(resolve => { resolveRecordStallEpisode = resolve })
    const forensics = {
      recordSyncSample: vi.fn().mockResolvedValue(undefined),
      recordStallEpisode: vi.fn().mockReturnValue(recordStallEpisodePromise),
      closeStallEpisode: vi.fn().mockResolvedValue(undefined),
      recordStallProgress: vi.fn().mockResolvedValue(undefined),
      recordStallSeenFlags: vi.fn().mockResolvedValue(undefined),
      recordStallReconnectAttempt: vi.fn().mockResolvedValue(undefined),
      recordStallReconnectSkipped: vi.fn().mockResolvedValue(undefined),
      recordStallReconnectWouldHaveFired: vi.fn().mockResolvedValue(undefined),
    } as unknown as DbForensics

    const { db, emit, queue } = makeAlwaysStalledDb()

    vi.useFakeTimers()
    try {
      watchSyncHealth(db, 'user-concurrent-race', stubReconnect(), forensics)
      await vi.advanceTimersByTimeAsync(ARM_TO_STALL_MS)
      expect(forensics.recordStallEpisode).toHaveBeenCalledTimes(1)
      const callsBeforeRace = (forensics.recordSyncSample as ReturnType<typeof vi.fn>).mock.calls.length
      // Sample that just went stalled is now suspended awaiting
      // recordStallEpisode — openStallEpisodeKey is still null. A second,
      // CLEARING sample fires in that window (without serialization it would
      // race the opening sample and see the stale null key).
      queue.pendingBlocks = 0
      queue.pendingRows = 0
      queue.lo = null
      queue.hi = null
      emit({ ...defaultSyncStatus(), lastSyncedAt: Date.now() })

      // Give the (unserialized, in a regression) second sample's own promise
      // chain plenty of microtask ticks to run all the way to its own
      // `closeStallEpisode` call BEFORE the opening sample's still-pending
      // `recordStallEpisode` await is resolved below.
      for (let i = 0; i < 20; i++) await Promise.resolve()

      resolveRecordStallEpisode('stall:1000')
      await vi.advanceTimersByTimeAsync(0)

      expect(forensics.recordSyncSample).toHaveBeenCalledTimes(callsBeforeRace + 2)
      expect(forensics.closeStallEpisode).toHaveBeenCalledTimes(1)
      expect(forensics.closeStallEpisode).toHaveBeenCalledWith('stall:1000', expect.anything())
    } finally {
      vi.useRealTimers()
    }
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

describe('uploadingSeen/downloadingSeen — latched at notification time (item 4)', () => {
  it('latches at NOTIFICATION time — a fast true-then-false toggle collapsed into one sample is still recorded as seen', async () => {
    // PowerSync sets `uploading` true immediately before awaiting
    // `uploadCrud` and clears it on failure — a fast-fail loop. The sampler
    // reading `db.currentStatus` only when IT runs (not when the
    // notification arrived) would miss a toggle that reverts before then.
    const forensics = stubSyncForensics()
    const { db, emit } = makeSyncDb()

    watchSyncHealth(db, 'user-latch', stubReconnect(), forensics)
    emit({ ...defaultSyncStatus(), dataFlowStatus: { uploading: true, downloading: false } })
    emit({ ...defaultSyncStatus(), dataFlowStatus: { uploading: false, downloading: false } })

    await vi.waitFor(() => expect(forensics.recordSyncSample).toHaveBeenCalledTimes(1))
    const sample = (forensics.recordSyncSample as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(sample.uploading).toBe(false) // instantaneous value at sample time — not CURRENTLY uploading
    expect(sample.uploadingSeen).toBe(true) // but it WAS seen uploading between samples
  })

  it('folds the latch into the very next sample, then resets it — a later sample with no further activity reports uploadingSeen matching the instantaneous value', async () => {
    vi.useFakeTimers()
    try {
      const forensics = stubSyncForensics()
      const { db, emit } = makeSyncDb()
      watchSyncHealth(db, 'user-latch-fold', stubReconnect(), forensics)
      await vi.advanceTimersByTimeAsync(0) // flush the immediate arm sample

      emit({ ...defaultSyncStatus(), dataFlowStatus: { uploading: true, downloading: false } })
      emit({ ...defaultSyncStatus(), dataFlowStatus: { uploading: false, downloading: false } })
      await vi.advanceTimersByTimeAsync(0)
      const folded = (forensics.recordSyncSample as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]
      expect(folded.uploading).toBe(false)
      expect(folded.uploadingSeen).toBe(true) // caught the transient true

      await vi.advanceTimersByTimeAsync(SYNC_SAMPLE_INTERVAL_MS) // pure interval tick, no new notification
      const next = (forensics.recordSyncSample as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]
      expect(next.uploading).toBe(false)
      expect(next.uploadingSeen).toBe(false) // latch was consumed by the previous sample and reset
    } finally {
      vi.useRealTimers()
    }
  })

  it('the open stall episode accumulates uploadingSeen/downloadingSeen across samples via recordStallSeenFlags, not just the onset value (item 10)', async () => {
    const forensics = stubSyncForensics()
    const { db, emit } = makeAlwaysStalledDb()

    vi.useFakeTimers()
    try {
      watchSyncHealth(db, 'user-episode-seen-flags', stubReconnect(), forensics)
      await vi.advanceTimersByTimeAsync(ARM_TO_STALL_MS)
      const openedKey = await (forensics.recordStallEpisode as ReturnType<typeof vi.fn>).mock.results[0].value
      // The onset sample itself was not uploading.
      expect((forensics.recordStallEpisode as ReturnType<typeof vi.fn>).mock.calls[0][0].uploadingSeen).toBe(false)

      // A LATER sample (still stalled) sees a transient uploading:true.
      emit({ ...defaultSyncStatus(), lastSyncedAt: Date.now() - SYNC_STALL_THRESHOLD_MS - 60_000, dataFlowStatus: { uploading: true, downloading: false } })
      await vi.advanceTimersByTimeAsync(0)

      expect(forensics.recordStallSeenFlags).toHaveBeenCalledWith(openedKey, true, false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('reconnect watchdog gate (item 6: off by default)', () => {
  it('does NOT call reconnect on a sustained stall by default — but records that it WOULD have fired', async () => {
    const forensics = stubSyncForensics()
    const reconnect = stubReconnect()
    const { db } = makeAlwaysStalledDb()

    vi.useFakeTimers()
    try {
      watchSyncHealth(db, 'user-watchdog-default-off', reconnect, forensics)
      // Reach 2 consecutive queue-age-stalled samples (item 7's own gate).
      await vi.advanceTimersByTimeAsync(ARM_TO_STALL_MS + SYNC_SAMPLE_INTERVAL_MS)

      expect(reconnect).not.toHaveBeenCalled()
      expect(forensics.recordStallReconnectAttempt).not.toHaveBeenCalled()
      expect(forensics.recordStallReconnectWouldHaveFired).toHaveBeenCalledWith(
        expect.any(String), expect.any(Number),
      )
    } finally {
      vi.useRealTimers()
    }
  })
})

// Arm `db` and advance fake timers until the watchdog's own eligibility gate
// (queue-age condition held for 2 consecutive KNOWN samples — item 7) is
// first met. Callers of this helper are testing "when the watchdog IS
// enabled" behavior and must call `__setReconnectWatchdogEnabledForTest(true)`
// themselves first.
const armAndReachWatchdogEligibility = async (
  db: Parameters<typeof watchSyncHealth>[0],
  userId: string,
  reconnect: ReturnType<typeof stubReconnect>,
  forensics: DbForensics,
): Promise<void> => {
  watchSyncHealth(db, userId, reconnect, forensics)
  await vi.advanceTimersByTimeAsync(ARM_TO_STALL_MS + SYNC_SAMPLE_INTERVAL_MS)
}

describe('reconnect watchdog (enabled)', () => {
  it('does not fire when the connection is healthy (no stall)', async () => {
    __setReconnectWatchdogEnabledForTest(true)
    const forensics = stubSyncForensics()
    const reconnect = stubReconnect()
    const { db } = makeSyncDb() // defaults: connected, hasSynced, lastSyncedAt=now, empty queue

    watchSyncHealth(db, 'user-watchdog-healthy', reconnect, forensics)
    await vi.waitFor(() => expect(forensics.recordSyncSample).toHaveBeenCalledTimes(1))

    expect(reconnect).not.toHaveBeenCalled()
  })

  it('requires the queue-age condition to hold for 2 CONSECUTIVE samples before firing — a single stalled sample is not enough (item 7)', async () => {
    __setReconnectWatchdogEnabledForTest(true)
    const forensics = stubSyncForensics()
    const reconnect = stubReconnect()
    const { db } = makeAlwaysStalledDb()

    vi.useFakeTimers()
    try {
      watchSyncHealth(db, 'user-watchdog-needs-2-samples', reconnect, forensics)
      // Land on the FIRST sample where queueOld just became true — not yet
      // a second consecutive one.
      await vi.advanceTimersByTimeAsync(ARM_TO_STALL_MS)
      expect(reconnect).not.toHaveBeenCalled()

      // One more sample (still stalled) — now 2 consecutive — fires.
      await vi.advanceTimersByTimeAsync(SYNC_SAMPLE_INTERVAL_MS)
      expect(reconnect).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does NOT act on syncStale alone — a freshly-queued backlog with a long-stale lastSyncedAt is recorded as stalled but does not trigger reconnect (item 7)', async () => {
    __setReconnectWatchdogEnabledForTest(true)
    const forensics = stubSyncForensics()
    const reconnect = stubReconnect()
    const veryStaleLastSyncedAt = Date.now() - 24 * 60 * 60_000 // a full day stale
    const queue = emptyQueueState()
    const db = {
      currentStatus: { ...defaultSyncStatus(), lastSyncedAt: veryStaleLastSyncedAt },
      getAll: vi.fn(async (sql: string) => {
        if (sql === uploadQueuePreviewCountSql) return [{ count: queue.pendingBlocks }]
        if (sql === uploadQueueRowCountSql) return [{ count: queue.pendingRows }]
        if (sql === uploadQueueEdgeSql) return [{ lo: queue.lo, hi: queue.hi }]
        return [{ count: 0 }]
      }),
    } as unknown as Parameters<typeof watchSyncHealth>[0]

    vi.useFakeTimers()
    try {
      watchSyncHealth(db, 'user-syncstale-only', reconnect, forensics)
      // Advance past the armedAt gate with the queue still EMPTY — syncStale
      // becomes eligible to fire once lastSyncedAt+armedAt both clear the
      // threshold, but there's nothing queued yet.
      await vi.advanceTimersByTimeAsync(SYNC_STALL_THRESHOLD_MS + SYNC_SAMPLE_INTERVAL_MS)

      // NOW queue a block for the first time — this sample's pendingSince
      // becomes "now", so queueOld is false, but syncStale (lastSyncedAt is
      // ancient AND armedAt-gate long since cleared) makes `stall` true.
      queue.pendingBlocks = 5
      queue.pendingRows = 5
      queue.lo = 1
      queue.hi = 5
      await vi.advanceTimersByTimeAsync(SYNC_SAMPLE_INTERVAL_MS)

      const lastSample = (forensics.recordSyncSample as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]
      expect(lastSample.stall).toBe(true) // recorded as stalled (syncStale-driven)...
      expect(reconnect).not.toHaveBeenCalled() // ...but the watchdog does not act on it
    } finally {
      vi.useRealTimers()
    }
  })

  it('fires reconnect once the queue-age condition has held for 2 consecutive samples', async () => {
    __setReconnectWatchdogEnabledForTest(true)
    const forensics = stubSyncForensics()
    const reconnect = stubReconnect()
    const { db } = makeAlwaysStalledDb()

    vi.useFakeTimers()
    try {
      await armAndReachWatchdogEligibility(db, 'user-watchdog-fire', reconnect, forensics)
      expect(reconnect).toHaveBeenCalledTimes(1)
      expect(reconnect).toHaveBeenCalledWith('user-watchdog-fire')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not re-fire within the backoff window — a second stall sample inside it is a no-op', async () => {
    __setReconnectWatchdogEnabledForTest(true)
    vi.useFakeTimers()
    try {
      const forensics = stubSyncForensics()
      const reconnect = stubReconnect()
      const { db } = makeAlwaysStalledDb()

      await armAndReachWatchdogEligibility(db, 'user-watchdog-backoff', reconnect, forensics)
      expect(reconnect).toHaveBeenCalledTimes(1)

      // Another sample well inside the 10min backoff window.
      await vi.advanceTimersByTimeAsync(SYNC_SAMPLE_INTERVAL_MS)
      expect(reconnect).toHaveBeenCalledTimes(1) // still just once
    } finally {
      vi.useRealTimers()
    }
  })

  it('escalates the backoff 10 → 20 → 40min, then caps at 60min', async () => {
    __setReconnectWatchdogEnabledForTest(true)
    vi.useFakeTimers()
    try {
      const forensics = stubSyncForensics()
      const reconnect = stubReconnect()
      const { db } = makeAlwaysStalledDb()

      await armAndReachWatchdogEligibility(db, 'user-watchdog-escalate', reconnect, forensics)
      expect(reconnect).toHaveBeenCalledTimes(1) // attempt #1

      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(reconnect).toHaveBeenCalledTimes(2) // the 10min gap elapsed

      await vi.advanceTimersByTimeAsync(20 * 60_000)
      expect(reconnect).toHaveBeenCalledTimes(3) // the 20min gap elapsed

      await vi.advanceTimersByTimeAsync(40 * 60_000)
      expect(reconnect).toHaveBeenCalledTimes(4) // the 40min gap elapsed

      // From here the gap is capped at 60min — the PREVIOUS 40min step must
      // NOT be enough to re-fire.
      await vi.advanceTimersByTimeAsync(40 * 60_000)
      expect(reconnect).toHaveBeenCalledTimes(4) // only 40min since the last attempt

      await vi.advanceTimersByTimeAsync(20 * 60_000) // completes the 60min cap gap
      expect(reconnect).toHaveBeenCalledTimes(5) // 60min since the last attempt
    } finally {
      vi.useRealTimers()
    }
  })

  it('resets the backoff once the queue drains, so a NEW episode does not have to wait out the OLD episode\'s escalated gap', async () => {
    __setReconnectWatchdogEnabledForTest(true)
    vi.useFakeTimers()
    try {
      const forensics = stubSyncForensics()
      const reconnect = stubReconnect()
      const { db, emit, queue } = makeAlwaysStalledDb()

      await armAndReachWatchdogEligibility(db, 'user-watchdog-reset', reconnect, forensics)
      expect(reconnect).toHaveBeenCalledTimes(1) // attempt #1

      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(reconnect).toHaveBeenCalledTimes(2) // attempt #2 — next gap escalates to 20min

      // Queue drains — stall clears.
      queue.pendingBlocks = 0
      queue.pendingRows = 0
      queue.lo = null
      queue.hi = null
      emit({ ...defaultSyncStatus(), lastSyncedAt: Date.now() })
      await vi.advanceTimersByTimeAsync(0)
      expect(reconnect).toHaveBeenCalledTimes(2) // no reconnect on a healthy sample

      // Stall returns — a NEW episode. Reaching ITS OWN 2-consecutive-sample
      // eligibility takes ARM_TO_STALL_MS-ish time again, well under the 20min
      // gap the OLD episode would have required — proving the backoff reset
      // rather than carrying the escalated schedule over.
      queue.pendingBlocks = 22
      queue.pendingRows = 22
      queue.lo = 1
      queue.hi = 22
      emit({ ...defaultSyncStatus(), lastSyncedAt: Date.now() - SYNC_STALL_THRESHOLD_MS - 60_000 })
      await vi.advanceTimersByTimeAsync(ARM_TO_STALL_MS + SYNC_SAMPLE_INTERVAL_MS)
      expect(reconnect).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a throwing reconnect does not break sampling', async () => {
    __setReconnectWatchdogEnabledForTest(true)
    const forensics = stubSyncForensics()
    const reconnect = vi.fn().mockRejectedValue(new Error('reconnect boom'))
    const { db, emit } = makeAlwaysStalledDb()

    // The watchdog now runs on its OWN single-flight chain (item 8),
    // separate from the sampler's — best-effort discipline means nothing
    // ever attaches a `.catch()` externally, so if it let a rejection
    // escape, it would surface as a genuine Node `unhandledRejection`, not
    // merely "the next sample didn't record". Capture the event directly so
    // a regression fails this test by name.
    const unhandledReasons: unknown[] = []
    const onUnhandledRejection = (reason: unknown) => unhandledReasons.push(reason)
    process.on('unhandledRejection', onUnhandledRejection)

    vi.useFakeTimers()
    try {
      await armAndReachWatchdogEligibility(db, 'user-watchdog-throws', reconnect, forensics)
      expect(reconnect).toHaveBeenCalledTimes(1)
      const samplesAtThrow = (forensics.recordSyncSample as ReturnType<typeof vi.fn>).mock.calls.length

      // Sampling keeps going on the next tick despite the (rejected) attempt.
      emit()
      await vi.advanceTimersByTimeAsync(0)
      expect(
        (forensics.recordSyncSample as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBeGreaterThan(samplesAtThrow)
    } finally {
      vi.useRealTimers()
      process.off('unhandledRejection', onUnhandledRejection)
    }

    expect(unhandledReasons).toEqual([])
  })

  it('records each attempt (count + timestamp) onto the open stall episode', async () => {
    __setReconnectWatchdogEnabledForTest(true)
    const forensics = stubSyncForensics()
    const reconnect = stubReconnect()
    const { db } = makeAlwaysStalledDb()

    vi.useFakeTimers()
    try {
      await armAndReachWatchdogEligibility(db, 'user-watchdog-record', reconnect, forensics)
      const openedKey = await (forensics.recordStallEpisode as ReturnType<typeof vi.fn>).mock.results[0].value

      expect(forensics.recordStallReconnectAttempt).toHaveBeenCalledWith(openedKey, expect.any(Number))
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('watchdog fires on its own chain (item 8: does not block sampling)', () => {
  it('a hung reconnect does not delay subsequent sync-health samples', async () => {
    __setReconnectWatchdogEnabledForTest(true)
    const forensics = stubSyncForensics()
    const reconnect = vi.fn(() => new Promise<void>(() => {})) // never resolves
    const { db } = makeAlwaysStalledDb()

    // Force the `!locks` fallback deterministically: modern Node ships a
    // REAL `navigator.locks` (Web Locks API), and this test's `reconnect`
    // never resolves — if run against the real LockManager, it would
    // acquire an actual OS-level exclusive lock and never release it,
    // leaking into (and breaking) every later test that touches the same
    // lock name. Stubbing `navigator` to an object with no `locks` sidesteps
    // that entirely; it isn't what this test is about anyway (item 8, not
    // the cross-tab lock).
    vi.stubGlobal('navigator', {})

    vi.useFakeTimers()
    try {
      await armAndReachWatchdogEligibility(db, 'user-watchdog-hung', reconnect, forensics)
      expect(reconnect).toHaveBeenCalledTimes(1) // fired, and is now hung forever

      const countAtFire = (forensics.recordSyncSample as ReturnType<typeof vi.fn>).mock.calls.length
      // Sampling must keep going — several more interval ticks despite the
      // hung reconnect never resolving.
      await vi.advanceTimersByTimeAsync(SYNC_SAMPLE_INTERVAL_MS * 5)
      expect(
        (forensics.recordSyncSample as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBeGreaterThanOrEqual(countAtFire + 5)
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
})

describe('cross-tab reconnect lock', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('skips the reconnect (and records the skip) when another tab holds the cross-tab lock', async () => {
    __setReconnectWatchdogEnabledForTest(true)
    const forensics = stubSyncForensics()
    const reconnect = stubReconnect()
    const { db } = makeAlwaysStalledDb()

    const request = vi.fn(async (_name: string, _opts: unknown, callback: (lock: null) => Promise<void>) => {
      await callback(null) // lock unavailable this round — another tab owns it
    })
    vi.stubGlobal('navigator', { locks: { request } })

    vi.useFakeTimers()
    try {
      await armAndReachWatchdogEligibility(db, 'user-watchdog-lock-contended', reconnect, forensics)

      expect(reconnect).not.toHaveBeenCalled()
      expect(forensics.recordStallReconnectAttempt).not.toHaveBeenCalled()
      expect(forensics.recordStallReconnectSkipped).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reconnects normally when the cross-tab lock IS acquired', async () => {
    __setReconnectWatchdogEnabledForTest(true)
    const forensics = stubSyncForensics()
    const reconnect = stubReconnect()
    const { db } = makeAlwaysStalledDb()

    const request = vi.fn(async (_name: string, _opts: unknown, callback: (lock: object) => Promise<void>) => {
      await callback({})
    })
    vi.stubGlobal('navigator', { locks: { request } })

    vi.useFakeTimers()
    try {
      await armAndReachWatchdogEligibility(db, 'user-watchdog-lock-acquired', reconnect, forensics)
      expect(reconnect).toHaveBeenCalledTimes(1)
      expect(forensics.recordStallReconnectSkipped).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a skipped attempt does not consume a backoff step — the same tab succeeds on the very next sample once the lock frees up', async () => {
    __setReconnectWatchdogEnabledForTest(true)
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
      await vi.advanceTimersByTimeAsync(ARM_TO_STALL_MS + SYNC_SAMPLE_INTERVAL_MS)
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
    // Pins the contract explicitly: an environment with no `locks` at all
    // must not silently stop reconnecting. Stubbed explicitly (rather than
    // relying on the ambient test environment) because modern Node ships a
    // REAL `navigator.locks` (Web Locks API) — this test is specifically
    // about the ABSENT case, not whichever behavior the current Node
    // version's real LockManager happens to exhibit.
    __setReconnectWatchdogEnabledForTest(true)
    vi.stubGlobal('navigator', {})
    const forensics = stubSyncForensics()
    const reconnect = stubReconnect()
    const { db } = makeAlwaysStalledDb()

    vi.useFakeTimers()
    try {
      await armAndReachWatchdogEligibility(db, 'user-watchdog-no-locks-api', reconnect, forensics)
      expect(reconnect).toHaveBeenCalledTimes(1)
      expect(forensics.recordStallReconnectSkipped).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a rejecting navigator.locks.request does not escape as an unhandled rejection (item 10)', async () => {
    __setReconnectWatchdogEnabledForTest(true)
    const forensics = stubSyncForensics()
    const reconnect = stubReconnect()
    const { db } = makeAlwaysStalledDb()

    const request = vi.fn(async () => { throw new Error('locks.request boom') })
    vi.stubGlobal('navigator', { locks: { request } })

    const unhandledReasons: unknown[] = []
    const onUnhandledRejection = (reason: unknown) => unhandledReasons.push(reason)
    process.on('unhandledRejection', onUnhandledRejection)

    vi.useFakeTimers()
    try {
      await armAndReachWatchdogEligibility(db, 'user-locks-request-rejects', reconnect, forensics)
      // The reconnect itself never ran (the lock request failed), but
      // crucially nothing escaped as an unhandled rejection, and sampling
      // kept going.
      expect(reconnect).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(SYNC_SAMPLE_INTERVAL_MS)
      expect(forensics.recordSyncSample).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
      process.off('unhandledRejection', onUnhandledRejection)
    }
    expect(unhandledReasons).toEqual([])
  })
})

describe('watch generation token (item 9: a torn-down watch cannot corrupt the next one)', () => {
  it('an in-flight sample from a torn-down watch does not record anything or call reconnect for its (stale) user', async () => {
    const forensicsA = stubSyncForensics()
    const forensicsB = stubSyncForensics()
    const reconnectA = stubReconnect()
    const reconnectB = stubReconnect()

    let resolveAGate: () => void = () => {}
    const aGate = new Promise<void>(resolve => { resolveAGate = resolve })
    const dbA = {
      currentStatus: defaultSyncStatus(),
      getAll: vi.fn(async (sql: string) => {
        await aGate // suspend A's sample mid-flight, modelling a slow query
        if (sql === uploadQueueEdgeSql) return [{ lo: null, hi: null }]
        return [{ count: 0 }]
      }),
    } as unknown as Parameters<typeof watchSyncHealth>[0]

    watchSyncHealth(dbA, 'user-A', reconnectA, forensicsA)
    // A's immediate sample has started and is now suspended inside getAll.

    // Teardown + re-arm for B — bumps the generation token and resets every
    // module global A's suspended sample would otherwise write into.
    stopSyncHealthWatch()
    const { db: dbB } = makeSyncDb()
    watchSyncHealth(dbB, 'user-B', reconnectB, forensicsB)
    await vi.waitFor(() => expect(forensicsB.recordSyncSample).toHaveBeenCalledTimes(1))
    expect((forensicsB.recordSyncSample as ReturnType<typeof vi.fn>).mock.calls[0][0].userId).toBe('user-B')

    // Now let A's suspended sample resume.
    resolveAGate()
    await new Promise(resolve => setTimeout(resolve, 0)) // flush A's resumed micro/macrotasks

    // A's sample must have bailed on the stale generation: no recording, no
    // reconnect call, for the user it was originally watching.
    expect(forensicsA.recordSyncSample).not.toHaveBeenCalled()
    expect(reconnectA).not.toHaveBeenCalled()
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
  const base = {
    lo: null as number | null,
    loKnown: true,
    lastLo: null as number | null,
    lastSyncedAt: null as number | null,
    pendingSince: null as number | null,
    armedAt: 0,
    now: 0,
    previousStall: false,
  }

  it('lo advancing resets pendingSince — a draining backlog is not a stall', () => {
    const r1 = computeSyncStall({ ...base, lo: 100, now: 0 })
    expect(r1).toMatchObject({ stall: false, pendingSince: 0, progressed: false })

    // 11 minutes later, lo has ADVANCED (a batch drained) — the clock resets
    // to `now` and there is still no stall, even past the threshold.
    const r2 = computeSyncStall({
      ...base, lo: 120, lastLo: 100, pendingSince: r1.pendingSince,
      now: 11 * 60_000, previousStall: r1.stall,
    })
    expect(r2).toMatchObject({ stall: false, pendingSince: 11 * 60_000, progressed: true })
  })

  it('a flat (non-advancing) lo past the threshold DOES stall', () => {
    const r1 = computeSyncStall({ ...base, lo: 100, now: 0 })
    const r2 = computeSyncStall({
      ...base, lo: 100, lastLo: 100, pendingSince: r1.pendingSince, now: 11 * 60_000, previousStall: r1.stall,
    })
    expect(r2.stall).toBe(true)
    expect(r2.progressed).toBe(false)
    expect(r2.queueOld).toBe(true)
  })

  it('loKnown=false retains the previous stall verdict and leaves pendingSince untouched', () => {
    const r = computeSyncStall({
      ...base, loKnown: false, lo: null, lastLo: 100, pendingSince: 12345, now: 99999, previousStall: true,
    })
    expect(r).toEqual({ stall: true, pendingSince: 12345, progressed: false, queueOld: false })
  })

  it('lo becoming null (queue drained to empty) clears pendingSince and is not a stall', () => {
    const r = computeSyncStall({
      ...base, lo: null, lastLo: 100, pendingSince: 0, now: 20 * 60_000, previousStall: true,
    })
    expect(r).toMatchObject({ stall: false, pendingSince: null })
  })

  describe('the armedAt gate (item 1: no boot false-positive from a persisted lastSyncedAt)', () => {
    it('syncStale does NOT fire when now - armedAt is still within the threshold, even with an ancient lastSyncedAt', () => {
      const r = computeSyncStall({
        lo: 5, loKnown: true, lastLo: null,
        lastSyncedAt: -10 * 60 * 60_000, // 10 "hours" old, persisted from before this session
        pendingSince: null, armedAt: 0, now: 0, previousStall: false,
      })
      // Neither syncStale (armedAt gate not cleared) nor queueOld (queue just
      // became non-empty this same sample) has tripped.
      expect(r.stall).toBe(false)
    })

    it('syncStale DOES fire once the session has been armed past the threshold, independent of queueOld', () => {
      const r = computeSyncStall({
        lo: 5, loKnown: true, lastLo: 5,
        lastSyncedAt: 0, // stale relative to `now`
        pendingSince: 19 * 60_000, // queue only "old" for 1 minute — queueOld would NOT trip on its own
        armedAt: 0, now: 20 * 60_000, // 20 minutes since arm — past the armedAt gate
        previousStall: false,
      })
      expect(r.stall).toBe(true)
      expect(r.queueOld).toBe(false) // confirms syncStale is doing the work here, not queueOld
    })

    it('queueOld is NOT gated by armedAt — pendingSince is itself session-local, so it can never be "old" faster than the session has actually run', () => {
      const r = computeSyncStall({
        lo: 5, loKnown: true, lastLo: 5,
        lastSyncedAt: 20 * 60_000, // fresh — syncStale would not trip
        pendingSince: 0, // been pending since t=0
        armedAt: 15 * 60_000, // armed relatively recently
        now: 20 * 60_000,
        previousStall: false,
      })
      expect(r.stall).toBe(true)
      expect(r.queueOld).toBe(true)
    })
  })
})
