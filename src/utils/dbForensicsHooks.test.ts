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
  }) as unknown as DbForensics

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

    watchSyncHealth(db, 'user-arm-1', forensics)
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

    watchSyncHealth(db, 'user-stall-true', forensics)
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

    watchSyncHealth(db, 'user-stall-empty-queue', forensics)
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

    watchSyncHealth(db, 'user-stall-recent-sync', forensics)
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

    watchSyncHealth(db, 'user-getall-throws', forensics)
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

      watchSyncHealth(a.db, 'user-rearm-A', forensics)
      await vi.advanceTimersByTimeAsync(0) // flush a's immediate sample
      expect(forensics.recordSyncSample).toHaveBeenCalledTimes(1)

      watchSyncHealth(b.db, 'user-rearm-B', forensics)
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
      watchSyncHealth(db, 'user-queue-old-fresh-sync', forensics)
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

    watchSyncHealth(db, 'user-episode-open', forensics)
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

    watchSyncHealth(db, 'user-episode-close', forensics)
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
