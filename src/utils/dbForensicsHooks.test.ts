import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetDbForensicsHooksForTest,
  looksLikeDbCorruptionForForensics,
  watchForRuntimeCorruption,
} from './dbForensicsHooks.js'
import { isLocalDbCorruptionError } from './localDbCorruption.js'
import type { DbForensics } from './dbForensics.js'
import {
  __resetLocalDbCorruptionSignalForTest,
  getLocalDbCorruptionSnapshot,
} from '@/data/localDbCorruptionSignal.js'

const stubForensics = () =>
  ({ captureCorruptionSnapshot: vi.fn().mockResolvedValue(null) }) as unknown as DbForensics

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
})

describe('looksLikeDbCorruptionForForensics', () => {
  it('matches the open-time phrasings the strict detector matches', () => {
    expect(looksLikeDbCorruptionForForensics(new Error('database disk image is malformed'))).toBe(true)
    expect(looksLikeDbCorruptionForForensics(new Error('file is not a database'))).toBe(true)
  })

  it('matches the runtime sync-apply phrasing, and is broader than the strict detector', () => {
    const runtime = new Error('powersync_control: internal SQLite call returned CORRUPT')
    expect(looksLikeDbCorruptionForForensics(runtime)).toBe(true)

    // Broader on purpose: a bare powersync_control failure (no CORRUPT phrasing)
    // is worth a forensic snapshot but must NOT trip the strict, reset-gating
    // detector that routes to the destructive recovery UI.
    const bare = new Error('powersync_control: sync iteration failed')
    expect(looksLikeDbCorruptionForForensics(bare)).toBe(true)
    expect(isLocalDbCorruptionError(bare)).toBe(false)
  })

  it('does not match benign errors', () => {
    expect(looksLikeDbCorruptionForForensics(new Error('malformed URL'))).toBe(false)
    expect(looksLikeDbCorruptionForForensics(new Error('network request failed'))).toBe(false)
    expect(looksLikeDbCorruptionForForensics(undefined)).toBe(false)
  })
})
