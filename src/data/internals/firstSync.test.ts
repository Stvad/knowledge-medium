import { describe, expect, it, vi } from 'vitest'
import { onFirstSync } from './firstSync'

describe('onFirstSync', () => {
  it('fires immediately when the workspace is already synced', () => {
    const cb = vi.fn()
    onFirstSync({ currentStatus: { hasSynced: true } }, cb)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('fires immediately when there is no sync layer (e.g. a non-PowerSync stub)', () => {
    const cb = vi.fn()
    onFirstSync({}, cb)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('waits for the synced status change, then disposes its listener', () => {
    let listener: { statusChanged?: (s: { hasSynced?: boolean | null }) => void } | undefined
    let disposed = false
    const db = {
      currentStatus: { hasSynced: false },
      registerListener: (l: typeof listener) => { listener = l; return () => { disposed = true } },
    }
    const cb = vi.fn()
    onFirstSync(db, cb)
    expect(cb).not.toHaveBeenCalled()
    listener?.statusChanged?.({ hasSynced: false }) // intermediate tick — still nothing
    expect(cb).not.toHaveBeenCalled()
    listener?.statusChanged?.({ hasSynced: true })
    expect(cb).toHaveBeenCalledTimes(1)
    expect(disposed).toBe(true)
  })

  it('never fires for a connected-but-never-synced session (local-only)', () => {
    const db = {
      currentStatus: { hasSynced: false },
      registerListener: (l: { statusChanged?: (s: { hasSynced?: boolean | null }) => void }) => {
        void l
        return () => {}
      },
    }
    const cb = vi.fn()
    const dispose = onFirstSync(db, cb)
    expect(cb).not.toHaveBeenCalled() // stays unfired; callers must not gate required work on it
    dispose()
  })
})
