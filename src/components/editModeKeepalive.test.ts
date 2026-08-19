import { describe, it, expect, vi } from 'vitest'
import {
  acquireEditModeKeepalive,
  resolveEditModeKeepalive,
  withEditModeKeepalive,
} from './editModeKeepalive.js'

// The latch is process-wide module state, so every test must release every
// hold it acquires (the `resolve` assertions double as leak checks: a stray
// hold would surface as a non-'exit' resolution in a later test).

describe('editModeKeepalive', () => {
  it('resolves to exit with no holds', () => {
    expect(resolveEditModeKeepalive()).toBe('exit')
  })

  it('a refocus hold keeps edit mode and refocuses', () => {
    const release = acquireEditModeKeepalive('refocus')
    expect(resolveEditModeKeepalive()).toBe('refocus')
    release()
    expect(resolveEditModeKeepalive()).toBe('exit')
  })

  it('a yield-focus hold keeps edit mode without refocusing', () => {
    const release = acquireEditModeKeepalive('yield-focus')
    expect(resolveEditModeKeepalive()).toBe('yield')
    release()
    expect(resolveEditModeKeepalive()).toBe('exit')
  })

  it('yield-focus wins while both are held, in either acquire order', () => {
    const releaseRefocus = acquireEditModeKeepalive('refocus')
    const releaseYield = acquireEditModeKeepalive('yield-focus')
    expect(resolveEditModeKeepalive()).toBe('yield')
    // Dropping the yield hold falls back to the still-held refocus hold.
    releaseYield()
    expect(resolveEditModeKeepalive()).toBe('refocus')
    releaseRefocus()
    expect(resolveEditModeKeepalive()).toBe('exit')
  })

  it('overlapping holds of the same mode compose (both must release)', () => {
    const releaseA = acquireEditModeKeepalive('refocus')
    const releaseB = acquireEditModeKeepalive('refocus')
    releaseA()
    expect(resolveEditModeKeepalive()).toBe('refocus') // B still holds
    releaseB()
    expect(resolveEditModeKeepalive()).toBe('exit')
  })

  it('release is idempotent — a double release frees only its own hold', () => {
    const releaseA = acquireEditModeKeepalive('refocus')
    const releaseB = acquireEditModeKeepalive('refocus')
    releaseA()
    releaseA() // second call is a no-op; must not decrement B's hold
    expect(resolveEditModeKeepalive()).toBe('refocus')
    releaseB()
    expect(resolveEditModeKeepalive()).toBe('exit')
  })
})

describe('withEditModeKeepalive', () => {
  it('holds during fn and KEEPS holding past resolution, releasing on the delay', async () => {
    vi.useFakeTimers()
    try {
      let duringFn: ReturnType<typeof resolveEditModeKeepalive> | undefined
      await withEditModeKeepalive('refocus', () => {
        duringFn = resolveEditModeKeepalive()
      })
      expect(duringFn).toBe('refocus')
      // The whole point: the hold lingers after fn resolves so the late
      // post-commit blur still sees it. It only clears once the timer fires.
      expect(resolveEditModeKeepalive()).toBe('refocus')
      vi.runAllTimers()
      expect(resolveEditModeKeepalive()).toBe('exit')
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases (after the delay) and re-throws when fn throws', async () => {
    vi.useFakeTimers()
    try {
      await expect(
        withEditModeKeepalive('refocus', () => {
          throw new Error('boom')
        }),
      ).rejects.toThrow('boom')
      // The release is scheduled in finally before the re-throw, so a throwing
      // action can't strand the hold.
      expect(resolveEditModeKeepalive()).toBe('refocus')
      vi.runAllTimers()
      expect(resolveEditModeKeepalive()).toBe('exit')
    } finally {
      vi.useRealTimers()
    }
  })
})
