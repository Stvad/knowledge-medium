// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PersistenceState } from '@/requestPersistentStorage'

const h = vi.hoisted(() => ({ changeListener: undefined as undefined | (() => void) }))

vi.mock('@/requestPersistentStorage.js', () => ({
  getPersistenceState: vi.fn(),
  subscribePersistenceChange: vi.fn((listener: () => void) => {
    h.changeListener = listener
    return () => {}
  }),
}))

import { getPersistenceState } from '@/requestPersistentStorage.js'
import {
  REQUEST_PERSISTENCE_ACTION_ID,
  persistenceDiagnosticSource,
  refreshPersistenceStatus,
} from '../persistenceStatus.ts'

const mockState = (state: PersistenceState) => {
  vi.mocked(getPersistenceState).mockResolvedValue(state)
}

describe('persistenceDiagnosticSource', () => {
  beforeEach(() => {
    vi.mocked(getPersistenceState).mockReset()
  })

  it('reports nothing when storage is already persistent', async () => {
    mockState({ supported: true, persisted: true, permission: 'granted' })
    await refreshPersistenceStatus()
    expect(persistenceDiagnosticSource.getSnapshot()).toBeNull()
  })

  it('reports nothing on an engine without the API (Safari)', async () => {
    mockState({ supported: false, persisted: false, permission: undefined })
    await refreshPersistenceStatus()
    expect(persistenceDiagnosticSource.getSnapshot()).toBeNull()
  })

  it('nudges with a Protect action when not persistent and not denied', async () => {
    mockState({ supported: true, persisted: false, permission: 'prompt' })
    await refreshPersistenceStatus()
    const snap = persistenceDiagnosticSource.getSnapshot()
    expect(snap?.nudge).toBe(true)
    expect(snap?.actionId).toBe(REQUEST_PERSISTENCE_ACTION_ID)
    expect(snap?.actionLabel).toBe('Protect')
  })

  it('shows blocked guidance with no action when the user denied', async () => {
    mockState({ supported: true, persisted: false, permission: 'denied' })
    await refreshPersistenceStatus()
    const snap = persistenceDiagnosticSource.getSnapshot()
    expect(snap?.summary).toMatch(/blocked/i)
    expect(snap?.actionId).toBeUndefined()
    expect(snap?.nudge).toBe(true)
  })

  it('discards a stale refresh that resolves after a newer one', async () => {
    // The first (not-persisted) read is gated so it resolves LAST; the second
    // (granted) read resolves first. The stale first must not clobber it.
    let releaseStale = () => {}
    const staleGate = new Promise<void>((resolve) => {
      releaseStale = resolve
    })
    vi.mocked(getPersistenceState)
      .mockImplementationOnce(async () => {
        await staleGate
        return { supported: true, persisted: false, permission: 'prompt' }
      })
      .mockImplementationOnce(async () => ({ supported: true, persisted: true, permission: 'granted' }))

    const stale = refreshPersistenceStatus()
    const fresh = refreshPersistenceStatus()
    await fresh
    expect(persistenceDiagnosticSource.getSnapshot()).toBeNull()

    releaseStale()
    await stale
    expect(persistenceDiagnosticSource.getSnapshot()).toBeNull()
  })

  it('clears the nudge when a late grant fires the persistence-change signal', async () => {
    // Subscribing wires the source to the persistence-change signal (the
    // Firefox late-grant path) and does the initial read.
    mockState({ supported: true, persisted: false, permission: 'prompt' })
    const unsub = persistenceDiagnosticSource.subscribe(() => {})
    await vi.waitFor(() => expect(persistenceDiagnosticSource.getSnapshot()?.nudge).toBe(true))

    // The boot request grants after that first read; the signal must refresh us.
    mockState({ supported: true, persisted: true, permission: 'granted' })
    h.changeListener?.()
    await vi.waitFor(() => expect(persistenceDiagnosticSource.getSnapshot()).toBeNull())
    unsub()
  })
})
