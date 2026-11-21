// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  firstSyncDispose: vi.fn(),
  onFirstSync: vi.fn((): (() => void) => h.firstSyncDispose),
  db: { id: 'db' } as unknown,
}))
vi.mock('@/data/internals/firstSync.js', () => ({ onFirstSync: h.onFirstSync }))
vi.mock('@/data/repoProvider.js', () => ({ getPowerSyncDb: () => h.db }))

const { armSharedLaneTriggers } = await import('./laneArming.js')

beforeEach(() => {
  h.onFirstSync.mockClear()
  h.firstSyncDispose.mockClear()
})
afterEach(() => vi.restoreAllMocks())

describe('armSharedLaneTriggers', () => {
  it('arms first-sync (for the user) AND a reconnect listener; dispose tears both down', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const settle = vi.fn()
    const reconnect = vi.fn()

    const dispose = armSharedLaneTriggers('u1', settle, reconnect)
    expect(h.onFirstSync).toHaveBeenCalledWith(h.db, settle)
    expect(add).toHaveBeenCalledWith('online', reconnect)

    dispose()
    expect(h.firstSyncDispose).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith('online', reconnect)
  })

  it('with no signed-in user, still arms reconnect but NOT first-sync (per-user db unavailable)', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const reconnect = vi.fn()

    // The down-lane mounts before sign-in; its `pass` re-checks auth at fire time, so the
    // reconnect trigger must still arm even though there's no user to bind first-sync to.
    const dispose = armSharedLaneTriggers(null, vi.fn(), reconnect)
    expect(h.onFirstSync).not.toHaveBeenCalled()
    expect(add).toHaveBeenCalledWith('online', reconnect)

    dispose() // does not throw though first-sync was never armed
  })
})
