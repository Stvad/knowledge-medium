// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PersistenceState } from '@/requestPersistentStorage'

vi.mock('@/requestPersistentStorage.js', () => ({
  getPersistenceState: vi.fn(),
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
})
