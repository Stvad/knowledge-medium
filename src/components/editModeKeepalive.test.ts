import { describe, it, expect } from 'vitest'
import { acquireEditModeKeepalive, resolveEditModeKeepalive } from './editModeKeepalive.js'

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
