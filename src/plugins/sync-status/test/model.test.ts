import { describe, expect, it } from 'vitest'
import { getSyncIndicatorView } from '../model.ts'

const baseInput = {
  localOnly: false,
  connected: true,
  connecting: false,
  hasSynced: true,
  uploading: false,
  downloading: false,
  pendingChanges: 0,
}

describe('getSyncIndicatorView', () => {
  it('shows the pending upload count from the local outbox', () => {
    const view = getSyncIndicatorView({
      ...baseInput,
      pendingChanges: 3,
    })

    expect(view.state).toBe('pending')
    expect(view.label).toBe('Pending')
    expect(view.pendingLabel).toBe('3')
    expect(view.title).toContain('3 local changes queued for upload')
  })

  it('shows download progress while preserving the pending count badge', () => {
    const view = getSyncIndicatorView({
      ...baseInput,
      downloading: true,
      pendingChanges: 12,
      downloadFraction: 0.625,
    })

    expect(view.state).toBe('downloading')
    expect(view.label).toBe('Sync 63%')
    expect(view.pendingLabel).toBe('12')
    expect(view.progressPercent).toBe(63)
    expect(view.spinning).toBe(true)
  })

  it('labels local-only sessions without presenting them as sync failures', () => {
    const view = getSyncIndicatorView({
      ...baseInput,
      localOnly: true,
      connected: false,
      pendingChanges: 1,
    })

    expect(view.state).toBe('local')
    expect(view.label).toBe('Local only')
    expect(view.pendingLabel).toBe('1')
    expect(view.title).toContain('1 local change stored locally')
  })

  it('surfaces sync errors before passive connection states', () => {
    const view = getSyncIndicatorView({
      ...baseInput,
      connected: false,
      errorMessage: 'JWT expired',
      pendingChanges: 2,
    })

    expect(view.state).toBe('error')
    expect(view.label).toBe('Sync issue')
    expect(view.title).toContain('JWT expired')
    expect(view.pendingLabel).toBe('2')
  })
})
