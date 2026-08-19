import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalDatabaseCorruptError } from '@/utils/localDbCorruption.js'
import {
  __resetLocalDbCorruptionSignalForTest,
  getLocalDbCorruptionSnapshot,
  reportRuntimeLocalDbCorruption,
  subscribeLocalDbCorruption,
} from './localDbCorruptionSignal.js'

afterEach(() => __resetLocalDbCorruptionSignalForTest())

describe('localDbCorruptionSignal', () => {
  it('starts empty', () => {
    expect(getLocalDbCorruptionSnapshot()).toBeNull()
  })

  it('reports a typed error carrying the userId and cause, and notifies subscribers', () => {
    const listener = vi.fn()
    subscribeLocalDbCorruption(listener)

    const cause = new Error('powersync_control: internal SQLite call returned CORRUPT')
    reportRuntimeLocalDbCorruption('user-1', cause)

    const snap = getLocalDbCorruptionSnapshot()
    expect(snap).toBeInstanceOf(LocalDatabaseCorruptError)
    expect(snap?.userId).toBe('user-1')
    expect(snap?.cause).toBe(cause)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('latches — a second report is ignored and does not re-notify', () => {
    const listener = vi.fn()
    subscribeLocalDbCorruption(listener)
    reportRuntimeLocalDbCorruption('user-1', new Error('first'))
    reportRuntimeLocalDbCorruption('user-2', new Error('second'))

    expect(getLocalDbCorruptionSnapshot()?.userId).toBe('user-1')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('unsubscribe stops notifications', () => {
    const listener = vi.fn()
    const off = subscribeLocalDbCorruption(listener)
    off()
    reportRuntimeLocalDbCorruption('user-1', new Error('x'))
    expect(listener).not.toHaveBeenCalled()
  })
})
