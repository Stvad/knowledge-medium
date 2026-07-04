// @vitest-environment node
/**
 * The optimistic mark's TTL must NOTIFY subscribers, not just be lazily
 * observable: the chip reads the store via useSyncExternalStore, which
 * only re-reads the snapshot on a notification — a mark the daemon
 * never answers would otherwise show "queued" forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ASKED_TTL_MS,
  clearAskedClaude,
  isAskedClaude,
  markAskedClaude,
  subscribeAskedClaude,
} from '../askedStore.ts'

describe('askedStore expiry', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('notifies subscribers when an unanswered mark ages out', () => {
    const snapshots: boolean[] = []
    const unsubscribe = subscribeAskedClaude(() => snapshots.push(isAskedClaude('block-expiry')))

    markAskedClaude('block-expiry')
    expect(snapshots).toEqual([true])

    vi.advanceTimersByTime(ASKED_TTL_MS + 1)
    expect(snapshots).toEqual([true, false])
    unsubscribe()
  })

  it('a re-ask restarts the expiry clock instead of firing on the old schedule', () => {
    markAskedClaude('block-reask')
    vi.advanceTimersByTime(ASKED_TTL_MS / 2)
    markAskedClaude('block-reask')

    // The original mark's schedule has now elapsed — the mark must survive.
    vi.advanceTimersByTime(ASKED_TTL_MS / 2 + 1)
    expect(isAskedClaude('block-reask')).toBe(true)

    vi.advanceTimersByTime(ASKED_TTL_MS / 2)
    expect(isAskedClaude('block-reask')).toBe(false)
  })

  it('an explicit clear cancels the pending expiry notification', () => {
    markAskedClaude('block-clear')
    clearAskedClaude('block-clear')

    const snapshots: boolean[] = []
    const unsubscribe = subscribeAskedClaude(() => snapshots.push(isAskedClaude('block-clear')))
    vi.advanceTimersByTime(ASKED_TTL_MS + 1)
    expect(snapshots).toEqual([])
    unsubscribe()
  })
})
