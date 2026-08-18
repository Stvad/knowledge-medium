// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { awaitClaimConverged, type ClaimConvergenceDeps } from './claimConvergence'

const CLAIM = 'claim-1'

/** Drives the gate with a clock the TEST advances. `sleep` parks until
 *  `tick()`, so the gate cannot burn through its deadline between two
 *  statements of a test. */
const harness = (opts: {timeoutMs?: number} = {}) => {
  let time = 0
  let pending = true
  let syncedAt: number | null = 100
  let release: (() => void) | null = null
  const listeners = new Set<() => void>()
  const deps: ClaimConvergenceDeps = {
    hasPendingUpload: async () => pending,
    lastSyncedAt: () => syncedAt,
    onStatusChange: (cb) => { listeners.add(cb); return () => listeners.delete(cb) },
    now: () => time,
    timeoutMs: opts.timeoutMs ?? 10_000,
    pollMs: 50,
    sleep: () => new Promise<void>(resolve => { release = resolve }),
  }
  const tick = async (): Promise<void> => {
    time += 50
    const r = release
    release = null
    r?.()
    for (const l of [...listeners]) l()
    await Promise.resolve()
    await Promise.resolve()
  }
  return {
    deps, tick,
    drainUpload: () => { pending = false },
    checkpoint: (at: number) => { syncedAt = at },
    setSynced: (v: number | null) => { syncedAt = v },
  }
}

describe('awaitClaimConverged', () => {
  it('waits for the upload to leave the queue AND a later checkpoint', async () => {
    const h = harness()
    const result = awaitClaimConverged(h.deps, CLAIM)
    await h.tick()

    // Still queued: a checkpoint now cannot carry the server's answer to a
    // claim the server has not yet received, so this must NOT satisfy it.
    h.checkpoint(200)
    await h.tick()

    h.drainUpload()
    await h.tick()
    h.checkpoint(300)
    await h.tick()
    await expect(result).resolves.toBe(true)
  })

  it('backs off rather than proceeding when the upload never drains', async () => {
    const h = harness({timeoutMs: 200})
    const result = awaitClaimConverged(h.deps, CLAIM)
    for (let i = 0; i < 10; i++) await h.tick()
    await expect(result).resolves.toBe(false)
  })

  it('backs off when the upload lands but no checkpoint follows', async () => {
    const h = harness({timeoutMs: 200})
    h.drainUpload()
    // `lastSyncedAt` frozen at its pre-upload value — we never hear back.
    const result = awaitClaimConverged(h.deps, CLAIM)
    for (let i = 0; i < 10; i++) await h.tick()
    await expect(result).resolves.toBe(false)
  })

  it('treats a first-ever checkpoint as convergence', async () => {
    const h = harness()
    h.setSynced(null)
    h.drainUpload()
    const result = awaitClaimConverged(h.deps, CLAIM)
    await h.tick()
    h.checkpoint(10)
    await h.tick()
    await expect(result).resolves.toBe(true)
  })
})
