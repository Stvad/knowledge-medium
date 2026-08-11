// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearPendingMove,
  getPendingMove,
  setPendingMove,
  subscribePendingMove,
  usePendingMoveIds,
} from '../pendingMove.ts'

// The store is a module singleton, so every test must leave it empty for
// the next one.
afterEach(() => { clearPendingMove() })

describe('pendingMove', () => {
  it('starts empty', () => {
    expect(getPendingMove()).toBeNull()
  })

  it('set/get/clear round-trip', () => {
    setPendingMove({ blockIds: ['a', 'b'], workspaceId: 'ws-1', clipboardText: '- a\n- b' , clipboardSynced: true })
    expect(getPendingMove()).toEqual({ blockIds: ['a', 'b'], workspaceId: 'ws-1', clipboardText: '- a\n- b' , clipboardSynced: true })

    clearPendingMove()
    expect(getPendingMove()).toBeNull()
  })

  it('setPendingMove replaces a prior pending move outright (no merge)', () => {
    setPendingMove({ blockIds: ['a'], workspaceId: 'ws-1', clipboardText: '- a' , clipboardSynced: true })
    setPendingMove({ blockIds: ['c'], workspaceId: 'ws-2', clipboardText: '- c' , clipboardSynced: true })
    expect(getPendingMove()).toEqual({ blockIds: ['c'], workspaceId: 'ws-2', clipboardText: '- c' , clipboardSynced: true })
  })

  it('notifies subscribers on set and on clear, but clearing an already-empty register is a no-op notify', () => {
    const calls: number[] = []
    const off = subscribePendingMove(() => calls.push(calls.length))

    setPendingMove({ blockIds: ['a'], workspaceId: 'ws-1', clipboardText: '- a' , clipboardSynced: true })
    expect(calls).toHaveLength(1)

    clearPendingMove()
    expect(calls).toHaveLength(2)

    // Nothing pending — clearing again must not fire a spurious notify.
    clearPendingMove()
    expect(calls).toHaveLength(2)

    off()
  })

  describe('usePendingMoveIds', () => {
    it('reflects the current pending ids and updates reactively', () => {
      const { result } = renderHook(() => usePendingMoveIds())
      expect(result.current).toBeNull()

      act(() => {
        setPendingMove({ blockIds: ['x', 'y'], workspaceId: 'ws-1', clipboardText: '- x\n- y' , clipboardSynced: true })
      })
      expect(result.current).toEqual(new Set(['x', 'y']))
      expect(result.current?.has('x')).toBe(true)
      expect(result.current?.has('z')).toBe(false)

      act(() => { clearPendingMove() })
      expect(result.current).toBeNull()
    })

    it('returns a snapshot that stays reference-stable across renders with no change', () => {
      setPendingMove({ blockIds: ['x'], workspaceId: 'ws-1', clipboardText: '- x' , clipboardSynced: true })
      const { result, rerender } = renderHook(() => usePendingMoveIds())
      const first = result.current
      rerender()
      // Same reference — proves getSnapshot isn't allocating a fresh Set
      // every read, which would violate useSyncExternalStore's contract
      // and could loop.
      expect(result.current).toBe(first)
    })
  })
})
