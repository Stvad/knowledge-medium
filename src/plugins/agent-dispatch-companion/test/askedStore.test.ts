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
  clearAskedAgent,
  isAskedAgent,
  markAskedAgent,
  subscribeAskedAgent,
} from '../askedStore.ts'

describe('askedStore expiry', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('notifies subscribers when an unanswered mark ages out', () => {
    const snapshots: boolean[] = []
    const unsubscribe = subscribeAskedAgent(() => snapshots.push(isAskedAgent('block-expiry')))

    markAskedAgent('block-expiry')
    expect(snapshots).toEqual([true])

    vi.advanceTimersByTime(ASKED_TTL_MS + 1)
    expect(snapshots).toEqual([true, false])
    unsubscribe()
  })

  it('a re-ask restarts the expiry clock instead of firing on the old schedule', () => {
    markAskedAgent('block-reask')
    vi.advanceTimersByTime(ASKED_TTL_MS / 2)
    markAskedAgent('block-reask')

    // The original mark's schedule has now elapsed — the mark must survive.
    vi.advanceTimersByTime(ASKED_TTL_MS / 2 + 1)
    expect(isAskedAgent('block-reask')).toBe(true)

    vi.advanceTimersByTime(ASKED_TTL_MS / 2)
    expect(isAskedAgent('block-reask')).toBe(false)
  })

  it('an explicit clear cancels the pending expiry notification', () => {
    markAskedAgent('block-clear')
    clearAskedAgent('block-clear')

    const snapshots: boolean[] = []
    const unsubscribe = subscribeAskedAgent(() => snapshots.push(isAskedAgent('block-clear')))
    vi.advanceTimersByTime(ASKED_TTL_MS + 1)
    expect(snapshots).toEqual([])
    unsubscribe()
  })
})
