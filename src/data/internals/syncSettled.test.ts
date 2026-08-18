// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { onSyncSettled } from './firstSync'

/** Minimal stand-in for PowerSync's status surface. `emit` drives a status
 *  change the way the real client does. */
const fakeDb = (initial: {connected?: boolean; downloading?: boolean; downloadError?: unknown} | null) => {
  const listeners: ((s: {connected?: boolean; dataFlowStatus?: {downloading?: boolean; downloadError?: unknown}}) => void)[] = []
  return {
    db: initial === null ? {} : {
      currentStatus: {
        connected: initial.connected,
        dataFlowStatus: {downloading: initial.downloading, downloadError: initial.downloadError},
      },
      registerListener: (l: {statusChanged?: (s: never) => void}) => {
        if (l.statusChanged) listeners.push(l.statusChanged as never)
        return () => { listeners.length = 0 }
      },
    },
    emit: (s: {connected?: boolean; downloading?: boolean; downloadError?: unknown}) => {
      for (const l of [...listeners]) l({
        connected: s.connected,
        dataFlowStatus: {downloading: s.downloading, downloadError: s.downloadError},
      })
    },
    get listenerCount() { return listeners.length },
  }
}

describe('onSyncSettled', () => {
  it('fires immediately when there is no sync layer at all', () => {
    // A local-only / stubbed db has nothing to wait for; gating on it forever
    // would silently disable every caller.
    let fired = 0
    onSyncSettled(fakeDb(null).db, () => { fired++ })
    expect(fired).toBe(1)
  })

  it('fires immediately when already connected and idle', () => {
    let fired = 0
    onSyncSettled(fakeDb({connected: true, downloading: false}).db, () => { fired++ })
    expect(fired).toBe(1)
  })

  it('waits while a download is in flight — the catch-up window', () => {
    // This is the case `onFirstSync` cannot see: a device that synced days ago
    // has `hasSynced === true` and would sail straight through.
    const {db, emit} = fakeDb({connected: true, downloading: true})
    let fired = 0
    onSyncSettled(db, () => { fired++ })
    expect(fired).toBe(0)

    emit({connected: true, downloading: true})
    expect(fired).toBe(0)

    emit({connected: true, downloading: false})
    expect(fired).toBe(1)
  })

  it('waits while disconnected, however idle', () => {
    // Not downloading because there is no connection is not "caught up".
    const {db, emit} = fakeDb({connected: false, downloading: false})
    let fired = 0
    onSyncSettled(db, () => { fired++ })
    expect(fired).toBe(0)

    emit({connected: true, downloading: false})
    expect(fired).toBe(1)
  })

  it('waits while a download error is outstanding', () => {
    // A failed attempt publishes `downloadError` and leaves it set until the
    // next successful sync clears it, so the retry gap reads as
    // connected-and-idle while the device is in fact behind.
    const {db, emit} = fakeDb({connected: true, downloading: true})
    let fired = 0
    onSyncSettled(db, () => { fired++ })

    emit({connected: true, downloading: false, downloadError: new Error('offline')})
    expect(fired).toBe(0)

    emit({connected: true, downloading: false})
    expect(fired).toBe(1)
  })

  it('fires once and detaches', () => {
    const harness = fakeDb({connected: false, downloading: false})
    let fired = 0
    onSyncSettled(harness.db, () => { fired++ })

    harness.emit({connected: true, downloading: false})
    harness.emit({connected: true, downloading: false})

    expect(fired).toBe(1)
    expect(harness.listenerCount).toBe(0)
  })

  it('the disposer detaches a gate that never opened', () => {
    const harness = fakeDb({connected: false, downloading: false})
    let fired = 0
    const dispose = onSyncSettled(harness.db, () => { fired++ })

    dispose()
    harness.emit({connected: true, downloading: false})

    expect(fired).toBe(0)
  })
})
