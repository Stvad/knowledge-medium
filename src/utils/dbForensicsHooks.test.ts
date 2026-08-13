import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetDbForensicsHooksForTest,
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
